"""Merchant side: dashboard numbers, transactions, refunds, webhooks, products, audit and metrics."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import Date, cast, func, or_, select, text
from sqlalchemy.orm import Session

from .. import observability, services
from ..db import get_session
from ..errors import ApiError
from ..idempotency import run_once
from ..models import AuditLog, Payment, Product, User, WebhookDelivery, WebhookEndpoint
from ..schemas import ProductIn, ProductOut, ProductPatch, RefundIn, WebhookEndpointIn
from ..security import merchant
from .store import idempotent_response

router = APIRouter(prefix="/api/merchant", tags=["merchant"])
IST = timezone(timedelta(hours=5, minutes=30))  # the store reports days in Indian time
FINAL = ("succeeded", "partially_refunded", "refunded", "failed")  # attempts that reached an outcome


def _ist_day(col):
    # India has no daylight saving, so a fixed +05:30 offset is exact (and needs no time-zone database)
    return cast(func.timezone(text("INTERVAL '+05:30'"), col), Date)


@router.get("/summary")
def summary(days: int = Query(30, ge=1, le=365), _: User = Depends(merchant), session: Session = Depends(get_session)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = dict(session.execute(
        select(Payment.status, func.count()).where(Payment.created_at >= since).group_by(Payment.status)
    ).all())
    captured, refunded = session.execute(
        select(func.coalesce(func.sum(Payment.amount_minor), 0), func.coalesce(func.sum(Payment.amount_refunded_minor), 0))
        .where(Payment.created_at >= since, Payment.status.in_(services.CAPTURED))
    ).one()
    n_captured = sum(rows.get(s, 0) for s in services.CAPTURED)
    n_final = sum(rows.get(s, 0) for s in FINAL)
    return {
        "days": days,
        "gross_minor": captured, "refunded_minor": refunded, "net_minor": captured - refunded,
        "payments": n_captured, "attempts": n_final,
        # success rate = attempts that captured money / attempts that reached an outcome (pending 3-D Secure excluded)
        "success_rate": round(n_captured / n_final, 4) if n_final else None,
        "avg_ticket_minor": round(captured / n_captured) if n_captured else 0,
        "blocked_by_fraud_rule": session.execute(
            select(func.count()).select_from(Payment).where(Payment.created_at >= since, Payment.decline_code == "velocity_blocked")
        ).scalar_one(),
    }


@router.get("/timeseries")
def timeseries(days: int = Query(14, ge=1, le=90), _: User = Depends(merchant), session: Session = Depends(get_session)):
    today = datetime.now(IST).date()
    start = today - timedelta(days=days - 1)
    day = _ist_day(Payment.created_at)
    rows = session.execute(
        select(day, Payment.status, func.count(), func.coalesce(func.sum(Payment.amount_minor), 0))
        .where(day >= start).group_by(day, Payment.status)
    ).all()
    out = {start + timedelta(days=i): {"succeeded": 0, "failed": 0, "captured_minor": 0} for i in range(days)}
    for d, status, n, amount in rows:
        bucket = out.get(d)
        if bucket is None:
            continue
        if status in services.CAPTURED:
            bucket["succeeded"] += n
            bucket["captured_minor"] += amount
        elif status == "failed":
            bucket["failed"] += n
    return [{"date": d.isoformat(), **v} for d, v in out.items()]


@router.get("/declines")
def declines(days: int = Query(30, ge=1, le=365), _: User = Depends(merchant), session: Session = Depends(get_session)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = session.execute(
        select(Payment.decline_code, func.count()).where(Payment.status == "failed", Payment.created_at >= since)
        .group_by(Payment.decline_code).order_by(func.count().desc())
    ).all()
    return [{"code": c or "unknown", "count": n} for c, n in rows]


@router.get("/payments")
def payments(
    q: str | None = Query(None, max_length=100, description="payment or order id, customer email, or last 4 digits"),
    status: str | None = Query(None, max_length=24),
    brand: str | None = Query(None, max_length=20),
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    _: User = Depends(merchant),
    session: Session = Depends(get_session),
):
    stmt = select(Payment, User.email).join(User, User.id == Payment.user_id)
    if q:
        q = q.strip()
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(Payment.id == q, Payment.order_id == q, func.lower(User.email).like(like), Payment.last4 == q))
    if status:
        stmt = stmt.where(Payment.status == status)
    if brand:
        stmt = stmt.where(Payment.brand == brand)
    total = session.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    rows = session.execute(stmt.order_by(Payment.created_at.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "limit": limit, "offset": offset,
            "items": [services.payment_dict(p) | {"customer_email": email} for p, email in rows]}


@router.get("/payments/{payment_id}")
def payment_detail(payment_id: str, _: User = Depends(merchant), session: Session = Depends(get_session)):
    p = session.get(Payment, payment_id)
    if p is None:
        raise ApiError(404, "Payment not found.", "payment_not_found")
    deliveries = session.execute(select(WebhookDelivery).where(WebhookDelivery.payment_id == p.id).order_by(WebhookDelivery.id)).scalars()
    return services.payment_dict(p) | {
        "customer": {"id": p.user.id, "email": p.user.email, "name": p.user.name},
        "order": services.order_dict(p.order),
        "events": [{"type": e.type, "detail": e.detail, "at": e.at.isoformat()} for e in p.events],
        "refunds": [{"id": r.id, "amount_minor": r.amount_minor, "reason": r.reason, "created_at": r.created_at.isoformat()} for r in p.refunds],
        "webhooks": [_delivery(d) for d in deliveries],
    }


@router.post("/payments/{payment_id}/refunds", status_code=201)
def refund(payment_id: str, body: RefundIn, user: User = Depends(merchant), key: str | None = Header(default=None, alias="Idempotency-Key"),
           session: Session = Depends(get_session)):
    def action():
        r = services.refund(session, user, payment_id, body.amount_minor, body.reason)
        return 201, {"id": r.id, "payment_id": payment_id, "amount_minor": r.amount_minor, "reason": r.reason}

    scope = f"POST /api/merchant/payments/{payment_id}/refunds"
    return idempotent_response(*run_once(session, user_id=user.id, key=key, scope=scope, body=body.model_dump(), action=action))


# ------------------------------------------------------------------ webhooks

def _delivery(d: WebhookDelivery) -> dict:
    return {
        "id": d.id, "event_id": d.event_id, "event_type": d.event_type, "payment_id": d.payment_id, "status": d.status,
        "attempts": d.attempts, "last_status_code": d.last_status_code, "last_error": d.last_error,
        "next_attempt_at": d.next_attempt_at.isoformat() if d.status == "pending" else None,
        "created_at": d.created_at.isoformat(), "delivered_at": d.delivered_at.isoformat() if d.delivered_at else None,
    }


@router.get("/webhooks")
def webhooks(status: str | None = Query(None, max_length=20), limit: int = Query(50, ge=1, le=200),
             _: User = Depends(merchant), session: Session = Depends(get_session)):
    ep = session.execute(select(WebhookEndpoint).order_by(WebhookEndpoint.id)).scalars().first()
    stmt = select(WebhookDelivery).order_by(WebhookDelivery.id.desc()).limit(limit)
    if status:
        stmt = stmt.where(WebhookDelivery.status == status)
    counts = dict(session.execute(select(WebhookDelivery.status, func.count()).group_by(WebhookDelivery.status)).all())
    return {
        # the secret is shown only as a hint; the full value is shown once, when it is created or rotated
        "endpoint": {"id": ep.id, "url": ep.url, "active": ep.active, "secret_hint": ep.secret[:10] + "…"} if ep else None,
        "counts": counts,
        "deliveries": [_delivery(d) for d in session.execute(stmt).scalars()],
    }


@router.put("/webhooks/endpoint")
def set_endpoint(body: WebhookEndpointIn, user: User = Depends(merchant), session: Session = Depends(get_session)):
    ep = session.execute(select(WebhookEndpoint).order_by(WebhookEndpoint.id)).scalars().first()
    new_secret = None
    if ep is None:
        new_secret = "whsec_" + secrets.token_hex(24)
        ep = WebhookEndpoint(url=body.url, secret=new_secret, active=body.active)
        session.add(ep)
    else:
        ep.url, ep.active = body.url, body.active
    session.flush()
    services.audit(session, f"merchant:{user.id}", "webhook_endpoint.updated", "webhook_endpoint", ep.id, url=body.url, active=body.active)
    session.commit()
    return {"id": ep.id, "url": ep.url, "active": ep.active, "secret": new_secret}


@router.post("/webhooks/deliveries/{delivery_id}/retry")
def retry_delivery(delivery_id: int, user: User = Depends(merchant), session: Session = Depends(get_session)):
    d = session.get(WebhookDelivery, delivery_id)
    if d is None:
        raise ApiError(404, "Delivery not found.")
    if d.status == "delivered":
        raise ApiError(409, "Already delivered.")
    d.status, d.next_attempt_at = "pending", datetime.now(timezone.utc)
    services.audit(session, f"merchant:{user.id}", "webhook.retry", "webhook_delivery", d.id)
    session.commit()
    return _delivery(d)


# ------------------------------------------------------------------ products, audit, metrics

@router.get("/products", response_model=list[ProductOut])
def all_products(_: User = Depends(merchant), session: Session = Depends(get_session)):
    return session.execute(select(Product).order_by(Product.id)).scalars().all()


@router.post("/products", response_model=ProductOut, status_code=201)
def create_product(body: ProductIn, user: User = Depends(merchant), session: Session = Depends(get_session)):
    p = Product(**body.model_dump())
    session.add(p)
    session.flush()
    services.audit(session, f"merchant:{user.id}", "product.created", "product", p.id, price_minor=p.price_minor)
    session.commit()
    return p


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(product_id: int, body: ProductPatch, user: User = Depends(merchant), session: Session = Depends(get_session)):
    p = session.get(Product, product_id)
    if p is None:
        raise ApiError(404, "Product not found.")
    changes = body.model_dump(exclude_none=True)
    for k, v in changes.items():
        setattr(p, k, v)
    services.audit(session, f"merchant:{user.id}", "product.updated", "product", p.id, **changes)
    session.commit()
    return p


@router.get("/audit")
def audit_log(entity_id: str | None = Query(None, max_length=40), limit: int = Query(50, ge=1, le=200),
              _: User = Depends(merchant), session: Session = Depends(get_session)):
    stmt = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    return [{"actor": a.actor, "action": a.action, "entity": a.entity, "entity_id": a.entity_id, "detail": a.detail, "at": a.at.isoformat()}
            for a in session.execute(stmt).scalars()]


@router.get("/metrics")
def metrics(_: User = Depends(merchant)):
    return observability.snapshot()

