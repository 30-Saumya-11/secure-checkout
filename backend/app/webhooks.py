"""Webhook delivery: signed POSTs to the merchant's endpoint, retried with exponential back-off.

Signature header:  Campus-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
The receiver recomputes the HMAC with its copy of the secret, compares in constant time and rejects old timestamps,
so a captured request cannot be replayed later and a forged one cannot be signed without the secret.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .models import WebhookDelivery, WebhookEndpoint

log = logging.getLogger("store.webhooks")

MAX_ATTEMPTS = 6
BASE_DELAY_S = 30  # 30 s, 1 min, 2 min, 4 min, 8 min, then give up
TOLERANCE_S = 300
HEADER = "Campus-Signature"


def sign(secret: str, body: bytes, t: int | None = None) -> str:
    t = int(time.time()) if t is None else t
    mac = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def verify(secret: str, body: bytes, header: str | None, now: int | None = None) -> bool:
    """What a merchant's server runs on every webhook it receives."""
    if not header:
        return False
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    now = int(time.time()) if now is None else now
    if abs(now - t) > TOLERANCE_S:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))


def backoff(attempts: int) -> timedelta:
    return timedelta(seconds=BASE_DELAY_S * 2 ** (attempts - 1))


def dispatch_due(session_factory: sessionmaker, client: httpx.Client, limit: int = 20) -> int:
    """Send deliveries whose time has come. Returns how many were attempted.

    FOR UPDATE SKIP LOCKED lets several workers run this at once without sending the same delivery twice.
    """
    with session_factory() as session:
        due = session.execute(
            select(WebhookDelivery)
            .where(WebhookDelivery.status == "pending", WebhookDelivery.next_attempt_at <= datetime.now(timezone.utc))
            .order_by(WebhookDelivery.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).scalars().all()
        for d in due:
            _attempt(session, client, d)
        session.commit()
        return len(due)


def _attempt(session: Session, client: httpx.Client, d: WebhookDelivery) -> None:
    ep = session.get(WebhookEndpoint, d.endpoint_id)
    body = json.dumps({"id": d.event_id, **d.payload}, separators=(",", ":")).encode()
    d.attempts += 1
    try:
        r = client.post(ep.url, content=body, timeout=5,
                        headers={"Content-Type": "application/json", HEADER: sign(ep.secret, body), "Campus-Event-Id": d.event_id})
        d.last_status_code, d.last_error = r.status_code, None if r.is_success else r.text[:300]
        ok = r.is_success
    except httpx.HTTPError as e:
        d.last_status_code, d.last_error, ok = None, f"{type(e).__name__}: {e}"[:300], False
    now = datetime.now(timezone.utc)
    if ok:
        d.status, d.delivered_at = "delivered", now
    elif d.attempts >= MAX_ATTEMPTS:
        d.status = "failed"
        log.warning("webhook %s gave up after %d attempts", d.event_id, d.attempts)
    else:
        d.next_attempt_at = now + backoff(d.attempts)


def start_dispatcher(session_factory: sessionmaker, interval_s: float) -> threading.Event:
    """Background loop for the web process. Returns an Event that stops it."""
    stop = threading.Event()

    def loop() -> None:
        with httpx.Client() as client:
            while not stop.is_set():
                try:
                    dispatch_due(session_factory, client)
                except Exception:  # a broken endpoint or a database blip must not kill the loop
                    log.exception("webhook dispatch failed")
                stop.wait(interval_s)

    threading.Thread(target=loop, name="webhooks", daemon=True).start()
    return stop
