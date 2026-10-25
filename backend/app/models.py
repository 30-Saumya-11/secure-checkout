"""Tables. Money is always an integer number of paise; never a float.

What is NOT here, on purpose: the card number and the CVC. The vault (card_tokens) keeps a random token, brand, last 4
digits, expiry and a keyed fingerprint (HMAC of the number) so the fraud rule can recognise the same card.
"""

from __future__ import annotations

import secrets
from datetime import datetime

from sqlalchemy import JSON, BigInteger, CheckConstraint, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

Json = JSON().with_variant(JSONB(), "postgresql")


def public_id(prefix: str) -> str:
    # random public ids (not 1, 2, 3...) so nobody can guess other customers' orders or payments
    return f"{prefix}_{secrets.token_hex(8)}"


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20))  # customer | merchant
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("role IN ('customer', 'merchant')", name="ck_users_role"),)


class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(500), default="")
    emoji: Mapped[str] = mapped_column(String(8), default="🛍️")
    price_minor: Mapped[int] = mapped_column(BigInteger)
    active: Mapped[bool] = mapped_column(default=True)
    __table_args__ = (CheckConstraint("price_minor > 0", name="ck_products_price"),)


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(String(24), primary_key=True, default=lambda: public_id("ord"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | paid | refunded
    total_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    items: Mapped[list[OrderItem]] = relationship(back_populates="order", order_by="OrderItem.id")
    user: Mapped[User] = relationship()


class OrderItem(Base):
    __tablename__ = "order_items"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    name: Mapped[str] = mapped_column(String(120))  # copied at order time, so later edits do not change old receipts
    unit_price_minor: Mapped[int] = mapped_column(BigInteger)
    quantity: Mapped[int] = mapped_column(Integer)
    order: Mapped[Order] = relationship(back_populates="items")


class CardToken(Base):
    """The vault. Never the card number or the CVC."""

    __tablename__ = "card_tokens"
    token: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: public_id("tok"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    brand: Mapped[str] = mapped_column(String(20))
    last4: Mapped[str] = mapped_column(String(4))
    exp_month: Mapped[int] = mapped_column(Integer)
    exp_year: Mapped[int] = mapped_column(Integer)
    # which simulated issuer response this test card gets (approve, decline, ...); a real gateway asks the issuer
    test_behaviour: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Payment(Base):
    __tablename__ = "payments"
    id: Mapped[str] = mapped_column(String(24), primary_key=True, default=lambda: public_id("pay"))
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    amount_refunded_minor: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    # requires_action | succeeded | partially_refunded | refunded | failed | canceled
    status: Mapped[str] = mapped_column(String(24), index=True)
    decline_code: Mapped[str | None] = mapped_column(String(40))
    card_token: Mapped[str] = mapped_column(ForeignKey("card_tokens.token"))
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    brand: Mapped[str] = mapped_column(String(20))
    last4: Mapped[str] = mapped_column(String(4))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    events: Mapped[list[PaymentEvent]] = relationship(order_by="PaymentEvent.id")
    refunds: Mapped[list[Refund]] = relationship(order_by="Refund.created_at")
    order: Mapped[Order] = relationship()
    user: Mapped[User] = relationship()
    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="ck_payments_amount"),
        # the database itself refuses a refund total above the captured amount, even if the code had a bug
        CheckConstraint("amount_refunded_minor >= 0 AND amount_refunded_minor <= amount_minor", name="ck_payments_refund_limit"),
    )


class PaymentEvent(Base):
    """Timeline shown on the payment detail page."""

    __tablename__ = "payment_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payment_id: Mapped[str] = mapped_column(ForeignKey("payments.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    detail: Mapped[str] = mapped_column(String(300), default="")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Refund(Base):
    __tablename__ = "refunds"
    id: Mapped[str] = mapped_column(String(24), primary_key=True, default=lambda: public_id("re"))
    payment_id: Mapped[str] = mapped_column(ForeignKey("payments.id"), index=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str] = mapped_column(String(200), default="")
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("amount_minor > 0", name="ck_refunds_amount"),)


class IdempotencyKey(Base):
    """One row per (user, key). Written in the SAME transaction as the action it protects."""

    __tablename__ = "idempotency_keys"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    key: Mapped[str] = mapped_column(String(100))
    scope: Mapped[str] = mapped_column(String(100))  # e.g. "POST /api/payments"
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int | None] = mapped_column(Integer)
    response: Mapped[dict | None] = mapped_column(Json)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_idempotency_user_key"),)


class WebhookEndpoint(Base):
    __tablename__ = "webhook_endpoints"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    url: Mapped[str] = mapped_column(String(500))
    secret: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(default=True)


class WebhookDelivery(Base):
    """Outbox: inserted in the same transaction as the payment change, sent later by the dispatcher."""

    __tablename__ = "webhook_deliveries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    endpoint_id: Mapped[int] = mapped_column(ForeignKey("webhook_endpoints.id"))
    event_id: Mapped[str] = mapped_column(String(24), default=lambda: public_id("evt"))
    event_type: Mapped[str] = mapped_column(String(40))
    payment_id: Mapped[str | None] = mapped_column(String(24), index=True)
    payload: Mapped[dict] = mapped_column(Json)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | delivered | failed
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    last_status_code: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor: Mapped[str] = mapped_column(String(80))  # "customer:3", "merchant:1", "system"
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(40))
    detail: Mapped[dict] = mapped_column(Json, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
