"""Refunds (limits, idempotency, concurrency) and who may do what."""

import threading

from conftest import key, order, pay, token
from sqlalchemy import func, select

from app.models import Refund


def refund(client, merchant, pid, amount=None, idem=None):
    body = {} if amount is None else {"amount_minor": amount}
    return client.post(f"/api/merchant/payments/{pid}/refunds", headers=merchant | (idem or key()), json=body)


def test_partial_then_full_refund(client, customer, merchant, products):
    p = pay(client, customer, products)
    assert refund(client, merchant, p["id"], 100000).status_code == 201
    d = client.get(f"/api/merchant/payments/{p['id']}", headers=merchant).json()
    assert d["status"] == "partially_refunded" and d["amount_refunded_minor"] == 100000
    rest = refund(client, merchant, p["id"])  # no amount = everything that is left
    assert rest.json()["amount_minor"] == 149900
    d = client.get(f"/api/merchant/payments/{p['id']}", headers=merchant).json()
    assert d["status"] == "refunded" and d["order"]["status"] == "refunded"
    assert [e["type"] for e in d["events"]].count("refund.created") == 2


def test_refund_cannot_exceed_captured_amount(client, customer, merchant, products):
    p = pay(client, customer, products)
    r = refund(client, merchant, p["id"], 249901)
    assert r.status_code == 409 and r.json()["code"] == "refund_exceeds_captured"


def test_failed_payment_cannot_be_refunded(client, customer, merchant, products):
    p = pay(client, customer, products, "4000000000000002")
    assert refund(client, merchant, p["id"]).json()["code"] == "not_refundable"


def test_refund_retry_with_same_key_refunds_once(client, customer, merchant, products, db):
    p = pay(client, customer, products)
    k = key()
    a, b = refund(client, merchant, p["id"], 50000, k), refund(client, merchant, p["id"], 50000, k)
    assert a.json() == b.json() and b.headers["Idempotent-Replayed"] == "true"
    assert db.execute(select(func.count()).select_from(Refund)).scalar_one() == 1


def test_concurrent_refunds_never_exceed_the_payment(client, customer, merchant, products, db):
    """Five support agents each refund ₹1,000 of a ₹2,499 payment at the same moment: only two can succeed."""
    p = pay(client, customer, products)
    start, codes = threading.Barrier(5), []

    def go():
        start.wait()
        codes.append(refund(client, merchant, p["id"], 100000).status_code)

    threads = [threading.Thread(target=go) for _ in range(5)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes) == [201, 201, 409, 409, 409]
    total = db.execute(select(func.sum(Refund.amount_minor))).scalar_one()
    assert total == 200000


def test_customers_cannot_use_merchant_endpoints(client, customer, products):
    p = pay(client, customer, products)
    assert client.get("/api/merchant/summary", headers=customer).status_code == 403
    assert refund(client, customer, p["id"]).status_code == 403


def test_customers_only_see_their_own_orders_and_payments(client, customer, other_customer, products):
    p = pay(client, customer, products)
    assert client.get(f"/api/orders/{p['order_id']}", headers=other_customer).status_code == 404
    assert client.get(f"/api/payments/{p['id']}", headers=other_customer).status_code == 404
    assert client.get("/api/orders", headers=other_customer).json() == []


def test_cannot_pay_someone_elses_order_or_use_their_card_token(client, customer, other_customer, products):
    o = order(client, customer, products)
    tok = token(client, other_customer)
    r = client.post("/api/payments", headers=other_customer | key(), json={"order_id": o["id"], "card_token": tok})
    assert r.status_code == 404
    o2 = order(client, other_customer, products)
    r = client.post("/api/payments", headers=other_customer | key(), json={"order_id": o2["id"], "card_token": token(client, customer)})
    assert r.status_code == 422


def test_signin_errors_do_not_reveal_which_emails_exist(client, customer):
    a = client.post("/api/auth/login", json={"email": "asha@example.com", "password": "wrong-password"})
    b = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong-password"})
    assert a.status_code == b.status_code == 401 and a.json() == b.json()


def test_missing_expired_or_forged_tokens_are_rejected(client):
    import jwt

    assert client.get("/api/auth/me").status_code == 401
    forged = jwt.encode({"sub": "1", "role": "merchant"}, "not-the-secret", algorithm="HS256")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401
    unsigned = jwt.encode({"sub": "1", "role": "merchant"}, None, algorithm="none")
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {unsigned}"}).status_code == 401


def test_register_then_duplicate_email(client):
    body = {"email": "New@Example.com", "name": "New User", "password": "long-enough-1"}
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 201 and r.json()["user"]["role"] == "customer" and r.json()["user"]["email"] == "new@example.com"
    assert client.post("/api/auth/register", json=body).status_code == 409


def test_order_prices_come_from_the_database(client, customer, products):
    r = client.post("/api/orders", headers=customer | key(),
                    json={"items": [{"product_id": products[0], "quantity": 2}, {"product_id": products[1], "quantity": 1}], "total_minor": 1})
    assert r.status_code == 201 and r.json()["total_minor"] == 2 * 249900 + 29900
