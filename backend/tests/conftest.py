"""Tests run against a REAL Postgres (row locks, ON CONFLICT and JSONB behave differently in SQLite).

DATABASE_URL set (CI uses a postgres service container) -> use it.
Not set -> start a throwaway Postgres with pgserver (pip install pgserver; no Docker needed).
"""

from __future__ import annotations

import logging
import os
import tempfile

# settings are read at import time, so the environment must be ready before `app` is imported
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-at-least-32-bytes-long")
os.environ.setdefault("CARD_FINGERPRINT_KEY", "test-fingerprint-key-at-least-32-bytes")
os.environ["WEBHOOK_DISPATCH"] = "false"  # tests call the dispatcher directly
os.environ.setdefault("DEMO_TOOLS", "true")

_server = None
if not os.environ.get("DATABASE_URL"):
    import pgserver

    _server = pgserver.get_server(tempfile.mkdtemp(prefix="store-test-pg-"), cleanup_mode="stop")
    os.environ["DATABASE_URL"] = _server.get_uri()

import uuid  # noqa: E402

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Product, User, WebhookEndpoint  # noqa: E402
from app.security import hash_password  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(scope="session", autouse=True)
def schema():
    # build the schema with the real migrations, so a broken migration fails the tests
    with engine.begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public"))
    cfg = Config(os.path.join(HERE, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(HERE, "migrations"))
    command.upgrade(cfg, "head")
    yield
    engine.dispose()
    if _server is not None:
        logging.getLogger("pgserver").disabled = True  # it logs during interpreter exit, after pytest closed the streams
        _server.cleanup()


@pytest.fixture(autouse=True)
def clean():
    tables = ", ".join(t.name for t in reversed(Base.metadata.sorted_tables))
    with engine.begin() as c:
        c.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db():
    with SessionLocal() as s:
        yield s


def make_user(role: str, email: str) -> int:
    with SessionLocal() as s:
        u = User(email=email, name=email.split("@")[0], role=role, password_hash=hash_password("password123"))
        s.add(u)
        s.commit()
        return u.id


def login(client: TestClient, email: str) -> dict:
    r = client.post("/api/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
def customer(client):
    make_user("customer", "asha@example.com")
    return login(client, "asha@example.com")


@pytest.fixture
def other_customer(client):
    make_user("customer", "ravi@example.com")
    return login(client, "ravi@example.com")


@pytest.fixture
def merchant(client):
    make_user("merchant", "boss@campus.store")
    return login(client, "boss@campus.store")


@pytest.fixture
def products():
    with SessionLocal() as s:
        items = [Product(name="Hoodie", price_minor=249900), Product(name="Mug", price_minor=29900)]
        s.add_all(items)
        s.commit()
        return [p.id for p in items]


@pytest.fixture
def endpoint():
    with SessionLocal() as s:
        ep = WebhookEndpoint(url="https://merchant.example/hooks", secret="whsec_test")
        s.add(ep)
        s.commit()
        return ep.id


def key() -> dict:
    return {"Idempotency-Key": uuid.uuid4().hex}


CARD = {"number": "4242 4242 4242 4242", "exp_month": 12, "exp_year": 2099, "cvc": "123", "name": "Asha Rao"}


def order(client, headers, products, qty=1) -> dict:
    r = client.post("/api/orders", headers=headers | key(), json={"items": [{"product_id": products[0], "quantity": qty}]})
    assert r.status_code == 201, r.text
    return r.json()


def token(client, headers, number="4242424242424242") -> str:
    cvc = "1234" if number.startswith("37") else "123"
    r = client.post("/api/cards/tokens", headers=headers, json=CARD | {"number": number, "cvc": cvc})
    assert r.status_code == 201, r.text
    return r.json()["token"]


def pay(client, headers, products, number="4242424242424242", idem=None) -> dict:
    o = order(client, headers, products)
    r = client.post("/api/payments", headers=headers | (idem or key()), json={"order_id": o["id"], "card_token": token(client, headers, number)})
    assert r.status_code == 201, r.text
    return r.json()
