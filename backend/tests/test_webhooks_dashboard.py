"""Webhooks (signing, retries, give-up) and the merchant dashboard numbers."""

import json
from datetime import datetime, timedelta, timezone

import httpx
from conftest import pay
from sqlalchemy import select, update

from app import webhooks
from app.db import SessionLocal
from app.models import WebhookDelivery


def receiver(responses: list[int], seen: list):
    """A fake merchant server: records what it received and answers with the next status code."""

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(responses.pop(0) if responses else 200)

    return httpx.Client(transport=httpx.MockTransport(handle))


def make_due(db):
    db.execute(update(WebhookDelivery).values(next_attempt_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    db.commit()


def test_signature_roundtrip_and_tampering():
    body = b'{"type":"payment.succeeded"}'
    header = webhooks.sign("whsec_x", body, t=1_700_000_000)
    assert webhooks.verify("whsec_x", body, header, now=1_700_000_010)
    assert not webhooks.verify("whsec_x", body + b" ", header, now=1_700_000_010)  # body changed
    assert not webhooks.verify("whsec_other", body, header, now=1_700_000_010)  # wrong secret
    assert not webhooks.verify("whsec_x", body, header, now=1_700_000_000 + 301)  # too old: replay
    assert not webhooks.verify("whsec_x", body, None)


def test_payment_events_are_delivered_signed(client, customer, products, endpoint):
    p = pay(client, customer, products)
    seen = []
    assert webhooks.dispatch_due(SessionLocal, receiver([], seen)) == 1
    req = seen[0]
    assert webhooks.verify("whsec_test", req.content, req.headers[webhooks.HEADER])
    payload = json.loads(req.content)
    assert payload["type"] == "payment.succeeded" and payload["data"]["id"] == p["id"]
    assert "4242424242424242" not in req.content.decode()
    with SessionLocal() as s:
        d = s.execute(select(WebhookDelivery)).scalar_one()
        assert d.status == "delivered" and d.attempts == 1 and d.last_status_code == 200


def test_failed_delivery_is_retried_with_backoff_then_succeeds(client, customer, products, endpoint, db):
    pay(client, customer, products)
    seen = []
    c = receiver([500, 503], seen)
    webhooks.dispatch_due(SessionLocal, c)
    d = db.execute(select(WebhookDelivery)).scalar_one()
    assert d.status == "pending" and d.attempts == 1
    assert d.next_attempt_at > datetime.now(timezone.utc) + timedelta(seconds=25)  # waits ~30 s, not immediately
    assert webhooks.dispatch_due(SessionLocal, c) == 0  # not due yet
    make_due(db)
    webhooks.dispatch_due(SessionLocal, c)
    make_due(db)
    webhooks.dispatch_due(SessionLocal, c)
    db.expire_all()
    d = db.execute(select(WebhookDelivery)).scalar_one()
    assert d.status == "delivered" and d.attempts == 3
    # every retry is the same event, so the merchant can de-duplicate by its id
    assert len({json.loads(r.content)["id"] for r in seen}) == 1


def test_delivery_gives_up_after_max_attempts(client, customer, products, endpoint, db):
    pay(client, customer, products)
    c = receiver([500] * 10, [])
    for _ in range(webhooks.MAX_ATTEMPTS):
        make_due(db)
        webhooks.dispatch_due(SessionLocal, c)
    db.expire_all()
    d = db.execute(select(WebhookDelivery)).scalar_one()
    assert d.status == "failed" and d.attempts == webhooks.MAX_ATTEMPTS


def test_backoff_doubles():
    assert [webhooks.backoff(n).total_seconds() for n in (1, 2, 3)] == [30, 60, 120]


def test_merchant_can_retry_a_failed_delivery(client, customer, merchant, products, endpoint, db):
    pay(client, customer, products)
    db.execute(update(WebhookDelivery).values(status="failed"))
    db.commit()
    d = db.execute(select(WebhookDelivery)).scalar_one()
    r = client.post(f"/api/merchant/webhooks/deliveries/{d.id}/retry", headers=merchant)
    assert r.status_code == 200 and r.json()["status"] == "pending"


def test_dashboard_numbers(client, customer, merchant, products):
    pay(client, customer, products)  # 2,499 captured
    pay(client, customer, products)
    pay(client, customer, products, "4000000000009995")  # declined
    p3ds = pay(client, customer, products, "4000000000003220")  # waiting for the bank: not an outcome yet
    assert p3ds["status"] == "requires_action"
    paid = pay(client, customer, products)
    client.post(f"/api/merchant/payments/{paid['id']}/refunds", headers=merchant | {"Idempotency-Key": "r1"}, json={"amount_minor": 49900})

    s = client.get("/api/merchant/summary", headers=merchant).json()
    assert s["gross_minor"] == 3 * 249900 and s["refunded_minor"] == 49900 and s["net_minor"] == 3 * 249900 - 49900
    assert s["payments"] == 3 and s["attempts"] == 4 and s["success_rate"] == 0.75
    assert s["avg_ticket_minor"] == 249900

    assert client.get("/api/merchant/declines", headers=merchant).json() == [{"code": "insufficient_funds", "count": 1}]
    ts = client.get("/api/merchant/timeseries?days=7", headers=merchant).json()
    assert len(ts) == 7 and ts[-1]["succeeded"] == 3 and ts[-1]["failed"] == 1


def test_transactions_search_and_filters(client, customer, other_customer, merchant, products):
    pay(client, customer, products)
    pay(client, other_customer, products, "5555555555554444")
    pay(client, other_customer, products, "4000000000000002")
    get = lambda qs: client.get(f"/api/merchant/payments?{qs}", headers=merchant).json()  # noqa: E731
    assert get("")["total"] == 3
    assert get("q=ravi")["total"] == 2
    assert get("q=4444")["items"][0]["brand"] == "mastercard"
    assert get("status=failed")["total"] == 1
    assert get("brand=visa")["total"] == 2
    assert get("limit=1&offset=1")["items"][0]["id"]


def test_requests_carry_a_request_id_and_metrics_group_by_route(client, customer, merchant, products):
    p = pay(client, customer, products)
    r = client.get("/api/health", headers={"X-Request-ID": "abc123"})
    assert r.headers["X-Request-ID"] == "abc123"
    client.get(f"/api/orders/{p['order_id']}", headers=customer)
    m = client.get("/api/merchant/metrics", headers=merchant).json()
    assert m["POST /api/payments"]["requests"] >= 1
    assert "GET /api/orders/{order_id}" in m
    assert not any("ord_" in name or "pay_" in name for name in m)  # templates, never concrete ids


def test_audit_log_records_who_did_what(client, customer, merchant, products):
    p = pay(client, customer, products)
    client.post(f"/api/merchant/payments/{p['id']}/refunds", headers=merchant | {"Idempotency-Key": "r2"}, json={})
    actions = {(a["actor"].split(":")[0], a["action"]) for a in client.get(f"/api/merchant/audit?entity_id={p['id']}", headers=merchant).json()}
    assert ("customer", "payment.created") in actions and ("merchant", "refund.created") in actions
