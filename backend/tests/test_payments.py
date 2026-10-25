"""Payments: idempotency (including truly concurrent retries), declines, 3-D Secure, the fraud rule, card data."""

import threading

from conftest import key, order, pay, token
from sqlalchemy import func, select, text

from app.db import engine
from app.models import Payment


def count_payments(db, status=None) -> int:
    stmt = select(func.count()).select_from(Payment)
    if status:
        stmt = stmt.where(Payment.status == status)
    return db.execute(stmt).scalar_one()


def test_successful_payment_marks_order_paid(client, customer, products):
    p = pay(client, customer, products)
    assert p["status"] == "succeeded" and p["brand"] == "visa" and p["last4"] == "4242"
    assert p["amount_minor"] == 249900  # from the database price, not from the browser
    assert client.get(f"/api/orders/{p['order_id']}", headers=customer).json()["status"] == "paid"


def test_idempotency_key_is_required(client, customer, products):
    o = order(client, customer, products)
    r = client.post("/api/payments", headers=customer, json={"order_id": o["id"], "card_token": token(client, customer)})
    assert r.status_code == 400 and r.json()["code"] == "idempotency_key_required"


def test_retry_with_same_key_replays_and_charges_once(client, customer, products, db):
    o = order(client, customer, products)
    body, h = {"order_id": o["id"], "card_token": token(client, customer)}, customer | key()
    first = client.post("/api/payments", headers=h, json=body)
    again = client.post("/api/payments", headers=h, json=body)
    assert first.status_code == again.status_code == 201
    assert again.headers["Idempotent-Replayed"] == "true"
    assert first.json() == again.json()
    assert count_payments(db) == 1


def test_same_key_different_body_is_a_conflict(client, customer, products):
    o1, o2 = order(client, customer, products), order(client, customer, products)
    h = customer | key()
    client.post("/api/payments", headers=h, json={"order_id": o1["id"], "card_token": token(client, customer)})
    r = client.post("/api/payments", headers=h, json={"order_id": o2["id"], "card_token": token(client, customer)})
    assert r.status_code == 409 and r.json()["code"] == "idempotency_conflict"


def test_concurrent_retries_with_same_key_create_one_payment(client, customer, products, db):
    """Two copies of the same request arrive at the same moment (a double click plus an automatic retry)."""
    o = order(client, customer, products)
    body, h = {"order_id": o["id"], "card_token": token(client, customer)}, customer | key()
    start, results = threading.Barrier(6), []

    def go():
        start.wait()
        r = client.post("/api/payments", headers=h, json=body)
        results.append((r.status_code, r.json()["id"]))

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert [s for s, _ in results] == [201] * 6
    assert len({pid for _, pid in results}) == 1  # everyone got the same payment
    assert count_payments(db) == 1


def test_concurrent_payments_with_different_keys_cannot_pay_one_order_twice(client, customer, products, db):
    o = order(client, customer, products)
    tok = token(client, customer)
    start, codes = threading.Barrier(5), []

    def go():
        start.wait()
        codes.append(client.post("/api/payments", headers=customer | key(), json={"order_id": o["id"], "card_token": tok}).status_code)

    threads = [threading.Thread(target=go) for _ in range(5)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(codes) == [201, 409, 409, 409, 409]  # the order row lock lets exactly one through
    assert count_payments(db, "succeeded") == 1


def test_lost_response_then_retry_returns_the_original_payment(client, customer, products, db):
    o = order(client, customer, products)
    body, h = {"order_id": o["id"], "card_token": token(client, customer)}, customer | key()
    lost = client.post("/api/payments", headers=h | {"X-Simulate-Lost-Response": "1"}, json=body)
    assert lost.status_code == 503  # the client thinks it failed...
    assert count_payments(db, "succeeded") == 1  # ...but the card was charged
    retry = client.post("/api/payments", headers=h, json=body)
    assert retry.status_code == 201 and retry.headers["Idempotent-Replayed"] == "true"
    assert count_payments(db) == 1


def test_declines_carry_a_code_and_leave_the_order_unpaid(client, customer, products):
    p = pay(client, customer, products, "4000000000009995")
    assert p["status"] == "failed" and p["decline_code"] == "insufficient_funds"
    assert p["message"] == "Your card has insufficient funds."
    assert client.get(f"/api/orders/{p['order_id']}", headers=customer).json()["status"] == "pending"


def test_3ds_success_and_wrong_code(client, customer, products):
    p = pay(client, customer, products, "4000000000003220")
    assert p["status"] == "requires_action"
    ok = client.post(f"/api/payments/{p['id']}/confirm", headers=customer | key(), json={"otp": "123456"})
    assert ok.status_code == 200 and ok.json()["status"] == "succeeded"

    p2 = pay(client, customer, products, "4000000000003220")
    bad = client.post(f"/api/payments/{p2['id']}/confirm", headers=customer | key(), json={"otp": "000000"})
    assert bad.json()["status"] == "failed" and bad.json()["decline_code"] == "authentication_failed"


def test_abandoned_3ds_cannot_charge_an_order_paid_another_way(client, customer, products, db):
    o = order(client, customer, products)
    first = client.post("/api/payments", headers=customer | key(), json={"order_id": o["id"], "card_token": token(client, customer, "4000000000003220")}).json()
    assert first["status"] == "requires_action"
    # the customer gives up on the bank page and pays with another card
    second = client.post("/api/payments", headers=customer | key(), json={"order_id": o["id"], "card_token": token(client, customer)}).json()
    assert second["status"] == "succeeded"
    late = client.post(f"/api/payments/{first['id']}/confirm", headers=customer | key(), json={"otp": "123456"})
    assert late.status_code == 409
    assert db.get(Payment, first["id"]).status == "canceled"
    assert count_payments(db, "succeeded") == 1


def test_velocity_rule_blocks_a_card_after_repeated_declines(client, customer, products, db):
    for _ in range(3):
        assert pay(client, customer, products, "4000000000000002")["decline_code"] == "card_declined"
    blocked = pay(client, customer, products, "4000000000000002")
    assert blocked["status"] == "failed" and blocked["decline_code"] == "velocity_blocked"
    # a different card is not affected
    assert pay(client, customer, products)["status"] == "succeeded"


def test_velocity_window_only_counts_recent_declines(client, customer, products, db):
    for _ in range(3):
        pay(client, customer, products, "4000000000000002")
    db.execute(text("UPDATE payments SET created_at = now() - interval '11 minutes'"))
    db.commit()
    assert pay(client, customer, products, "4000000000000002")["decline_code"] == "card_declined"


def test_card_number_and_cvc_are_never_stored(client, customer, products):
    pay(client, customer, products, "4000000000003220")
    with engine.connect() as c:
        dump = " ".join(str(v) for t in ("card_tokens", "payments", "payment_events", "idempotency_keys", "audit_log", "webhook_deliveries")
                        for row in c.execute(text(f"SELECT * FROM {t}")) for v in row)
    assert "4000000000003220" not in dump and "4000 0000 0000 3220" not in dump
    assert "3220" in dump  # only the last 4 digits


def test_invalid_cards_are_rejected_before_tokenising(client, customer):
    for bad in ({"number": "4242424242424241"}, {"exp_year": 2020}, {"cvc": "12"}, {"exp_month": 13}):
        body = {"number": "4242424242424242", "exp_month": 12, "exp_year": 2099, "cvc": "123", "name": "Asha"} | bad
        assert client.post("/api/cards/tokens", headers=customer, json=body).status_code == 422, bad
