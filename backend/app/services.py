"""Business rules: orders, payments, 3-D Secure, refunds, the fraud rule, audit and the webhook outbox.

Every function here runs inside the caller's transaction and never commits; the route (through run_once) commits
the action, its idempotency key, its audit row and its webhook deliveries together, or none of them.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import gateway
from .config import settings
from .errors import ApiError
from .models import AuditLog, CardToken, Order, OrderItem, Payment, PaymentEvent, Product, Refund, User, WebhookDelivery, WebhookEndpoint

CAPTURED = ("succeeded", "partially_refunded", "refunded")  # states in which money moved


def rupees(minor: int) -> str:
    return f"₹{minor / 100:,.2f}"


def audit(session: Session, actor: str, action: str, entity: str, entity_id: str, **detail) -> None:
    session.add(AuditLog(actor=actor, action=action, entity=entity, entity_id=str(entity_id), detail=detail))


def event(session: Session, payment: Payment, type_: str, detail: str = "") -> None:
    session.add(PaymentEvent(payment_id=payment.id, type=type_, detail=detail))


# ------------------------------------------------------------------ serialisers (plain dicts: they are also stored
# as idempotent responses, so they must be JSON)

def order_dict(o: Order) -> dict:
    return {
        "id": o.id, "status": o.status, "total_minor": o.total_minor, "currency": o.currency,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "items": [{"product_id": i.product_id, "name": i.name, "unit_price_minor": i.unit_price_minor, "quantity": i.quantity} for i in o.items],
    }


def payment_dict(p: Payment) -> dict:
    return {
        "id": p.id, "order_id": p.order_id, "status": p.status, "amount_minor": p.amount_minor,
        "amount_refunded_minor": p.amount_refunded_minor, "currency": p.currency, "decline_code": p.decline_code,
        "message": gateway.DECLINE_MESSAGES.get(p.decline_code or "", None), "brand": p.brand, "last4": p.last4,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


# ------------------------------------------------------------------ webhooks outbox

def enqueue_webhook(session: Session, event_type: str, payment: Payment, extra: dict | None = None) -> None:
    """Queue one delivery per active endpoint. Sent later by webhooks.dispatch_due(), never inside the request."""
    data = payment_dict(payment) | (extra or {})
    for ep in session.execute(select(WebhookEndpoint).where(WebhookEndpoint.active.is_(True))).scalars():
        session.add(WebhookDelivery(endpoint_id=ep.id, event_type=event_type, payment_id=payment.id,
                                    payload={"type": event_type, "data": data}))


# ------------------------------------------------------------------ orders

def create_order(session: Session, user: User, lines: list[tuple[int, int]]) -> Order:
    qty: dict[int, int] = {}
    for pid, q in lines:  # the same product twice in the cart is one line
        qty[pid] = qty.get(pid, 0) + q
    products = {p.id: p for p in session.execute(select(Product).where(Product.id.in_(qty))).scalars()}
    missing = [pid for pid in qty if pid not in products or not products[pid].active]
    if missing:
        raise ApiError(422, f"Product {missing[0]} is not available.", "product_unavailable")
    order = Order(user_id=user.id, total_minor=sum(products[pid].price_minor * q for pid, q in qty.items()))
    order.items = [OrderItem(product_id=pid, name=products[pid].name, unit_price_minor=products[pid].price_minor, quantity=q) for pid, q in qty.items()]
    session.add(order)
    session.flush()
    audit(session, f"customer:{user.id}", "order.created", "order", order.id, total_minor=order.total_minor)
    return order


# ------------------------------------------------------------------ cards

def tokenise(session: Session, user: User, number: str, exp_month: int, exp_year: int, cvc: str) -> CardToken:
    try:
        card = gateway.check_card(number, exp_month, exp_year, cvc)
    except gateway.CardError as e:
        raise ApiError(422, str(e), "invalid_card") from None
    tok = CardToken(user_id=user.id, fingerprint=card.fingerprint, brand=card.brand, last4=card.last4,
                    exp_month=card.exp_month, exp_year=card.exp_year, test_behaviour=card.test_behaviour)
    session.add(tok)
    session.flush()
    return tok


# ------------------------------------------------------------------ payments

def recent_declines(session: Session, fingerprint: str) -> int:
    since = datetime.now(timezone.utc) - timedelta(minutes=settings.velocity_window_min)
    return session.execute(
        select(func.count()).select_from(Payment).where(
            Payment.fingerprint == fingerprint, Payment.status == "failed", Payment.created_at >= since,
            Payment.decline_code != "velocity_blocked",  # blocked attempts never reached the issuer
        )
    ).scalar_one()


def create_payment(session: Session, user: User, order_id: str, card_token: str) -> Payment:
    # lock the order row: two payments for the same order cannot both see it as "pending"
    order = session.execute(select(Order).where(Order.id == order_id).with_for_update()).scalar_one_or_none()
    if order is None or order.user_id != user.id:
        raise ApiError(404, "Order not found.", "order_not_found")
    if order.status != "pending":
        raise ApiError(409, "This order has already been paid.", "order_already_paid")
    tok = session.get(CardToken, card_token)
    if tok is None or tok.user_id != user.id:
        raise ApiError(422, "Unknown card token.", "invalid_card")

    pay = Payment(order_id=order.id, user_id=user.id, amount_minor=order.total_minor, card_token=tok.token,
                  fingerprint=tok.fingerprint, brand=tok.brand, last4=tok.last4, status="processing")
    session.add(pay)
    session.flush()
    event(session, pay, "payment.created", f"{tok.brand} •••• {tok.last4}")

    # fraud rule: too many recent declines for this card -> do not even ask the issuer
    if recent_declines(session, tok.fingerprint) >= settings.velocity_max_declines:
        pay.status, pay.decline_code = "failed", "velocity_blocked"
        event(session, pay, "payment.blocked",
              f"{settings.velocity_max_declines}+ declines for this card in {settings.velocity_window_min} min")
        audit(session, "system", "payment.blocked", "payment", pay.id, rule="velocity", fingerprint=tok.fingerprint[:12])
        enqueue_webhook(session, "payment.failed", pay)
        return pay

    result = gateway.authorise(tok.test_behaviour, pay.amount_minor)
    pay.status, pay.decline_code = result.status, result.decline_code
    if result.status == "succeeded":
        order.status = "paid"
        event(session, pay, "payment.succeeded", "Authorised and captured")
        enqueue_webhook(session, "payment.succeeded", pay)
    elif result.status == "requires_action":
        event(session, pay, "payment.requires_action", "Bank asked for 3-D Secure verification")
    else:
        event(session, pay, "payment.failed", f"Declined by issuer: {result.decline_code}")
        enqueue_webhook(session, "payment.failed", pay)
    audit(session, f"customer:{user.id}", "payment.created", "payment", pay.id, status=pay.status, amount_minor=pay.amount_minor)
    return pay


def confirm_3ds(session: Session, user: User, payment_id: str, otp: str) -> Payment:
    pay = session.execute(select(Payment).where(Payment.id == payment_id).with_for_update()).scalar_one_or_none()
    if pay is None or pay.user_id != user.id:
        raise ApiError(404, "Payment not found.", "payment_not_found")
    if pay.status != "requires_action":
        raise ApiError(409, "This payment does not need verification.", "nothing_to_confirm")
    order = session.execute(select(Order).where(Order.id == pay.order_id).with_for_update()).scalar_one()
    if order.status != "pending":
        # the customer abandoned this verification and paid with another attempt: never charge twice.
        # Returned, not raised, so the cancellation is saved (the route answers 409).
        pay.status = "canceled"
        event(session, pay, "payment.canceled", "The order was already paid by another attempt")
        audit(session, f"customer:{user.id}", "payment.canceled", "payment", pay.id)
        return pay
    if otp != gateway.TEST_OTP:
        pay.status, pay.decline_code = "failed", "authentication_failed"
        event(session, pay, "payment.failed", "3-D Secure verification failed")
        enqueue_webhook(session, "payment.failed", pay)
    else:
        pay.status = "succeeded"
        order.status = "paid"
        event(session, pay, "payment.succeeded", "3-D Secure verified, captured")
        enqueue_webhook(session, "payment.succeeded", pay)
    audit(session, f"customer:{user.id}", "payment.confirmed", "payment", pay.id, status=pay.status)
    return pay


# ------------------------------------------------------------------ refunds

def refund(session: Session, merchant: User, payment_id: str, amount_minor: int | None, reason: str) -> Refund:
    # SELECT ... FOR UPDATE: two refunds for the same payment run one after the other, so the second one sees what
    # the first refunded. Without the lock both could read "₹500 left" and refund ₹500 each.
    pay = session.execute(select(Payment).where(Payment.id == payment_id).with_for_update()).scalar_one_or_none()
    if pay is None:
        raise ApiError(404, "Payment not found.", "payment_not_found")
    if pay.status not in ("succeeded", "partially_refunded"):
        raise ApiError(409, f"A {pay.status} payment cannot be refunded.", "not_refundable")
    left = pay.amount_minor - pay.amount_refunded_minor
    amount = left if amount_minor is None else amount_minor
    if amount > left:
        raise ApiError(409, f"Only {left} paise can still be refunded.", "refund_exceeds_captured")
    r = Refund(payment_id=pay.id, amount_minor=amount, reason=reason, created_by=merchant.id)
    session.add(r)
    pay.amount_refunded_minor += amount
    full = pay.amount_refunded_minor == pay.amount_minor
    pay.status = "refunded" if full else "partially_refunded"
    if full:
        session.get(Order, pay.order_id).status = "refunded"
    session.flush()
    event(session, pay, "refund.created", f"{rupees(amount)} refunded" + (f": {reason}" if reason else ""))
    enqueue_webhook(session, "refund.created", pay, {"refund": {"id": r.id, "amount_minor": amount}})
    audit(session, f"merchant:{merchant.id}", "refund.created", "payment", pay.id, refund_id=r.id, amount_minor=amount)
    return r
