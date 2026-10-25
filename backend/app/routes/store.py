"""Customer side: sign-in, products, orders, card tokens, payments and 3-D Secure."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .. import services
from ..config import settings
from ..db import get_session
from ..errors import ApiError
from ..idempotency import run_once
from ..models import Order, Payment, Product, User
from ..schemas import ConfirmIn, LoginIn, OrderIn, PaymentIn, ProductOut, RegisterIn, TokenisedCard, TokeniseIn, TokenOut, UserOut
from ..security import check_password, current_user, hash_password, issue_token

router = APIRouter(prefix="/api")
IdemKey = Header(default=None, alias="Idempotency-Key")
LostResponse = Header(default=None, alias="X-Simulate-Lost-Response")


def idempotent_response(status: int, body: dict, replayed: bool, lose: str | None = None) -> JSONResponse:
    # demo tool: the action has been committed, but the client is told the network failed. The client's retry with
    # the same key must get the saved result, not a second charge.
    if lose and settings.demo_tools and not replayed:
        return JSONResponse({"detail": "Simulated lost response (demo tool)."}, status_code=503)
    return JSONResponse(body, status_code=status, headers={"Idempotent-Replayed": "true"} if replayed else {})


# ------------------------------------------------------------------ auth

@router.post("/auth/register", response_model=TokenOut, status_code=201, tags=["auth"])
def register(body: RegisterIn, session: Session = Depends(get_session)):
    user = User(email=body.email, name=body.name.strip(), password_hash=hash_password(body.password), role="customer")
    session.add(user)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise ApiError(409, "An account with this email already exists.", "email_taken") from None
    return {"token": issue_token(user), "user": user}


@router.post("/auth/login", response_model=TokenOut, tags=["auth"])
def login(body: LoginIn, session: Session = Depends(get_session)):
    user = session.execute(select(User).where(User.email == body.email.strip().lower())).scalar_one_or_none()
    # same message whether the email or the password is wrong: do not reveal which accounts exist
    if user is None or not check_password(body.password, user.password_hash):
        raise ApiError(401, "Wrong email or password.", "bad_credentials")
    return {"token": issue_token(user), "user": user}


@router.get("/auth/me", response_model=UserOut, tags=["auth"])
def me(user: User = Depends(current_user)):
    return user


# ------------------------------------------------------------------ catalogue

@router.get("/products", response_model=list[ProductOut], tags=["store"])
def products(session: Session = Depends(get_session)):
    return session.execute(select(Product).where(Product.active.is_(True)).order_by(Product.id)).scalars().all()


# ------------------------------------------------------------------ orders

@router.post("/orders", status_code=201, tags=["store"])
def create_order(body: OrderIn, user: User = Depends(current_user), key: str | None = IdemKey, session: Session = Depends(get_session)):
    def action():
        return 201, services.order_dict(services.create_order(session, user, [(l.product_id, l.quantity) for l in body.items]))

    return idempotent_response(*run_once(session, user_id=user.id, key=key, scope="POST /api/orders", body=body.model_dump(), action=action))


@router.get("/orders", tags=["store"])
def my_orders(user: User = Depends(current_user), session: Session = Depends(get_session)):
    orders = session.execute(select(Order).where(Order.user_id == user.id).options(selectinload(Order.items)).order_by(Order.created_at.desc())).scalars()
    return [services.order_dict(o) for o in orders]


@router.get("/orders/{order_id}", tags=["store"])
def get_order(order_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)):
    o = session.get(Order, order_id)
    if o is None or (o.user_id != user.id and user.role != "merchant"):
        raise ApiError(404, "Order not found.", "order_not_found")
    pays = session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at)).scalars()
    return services.order_dict(o) | {"payments": [services.payment_dict(p) for p in pays]}


# ------------------------------------------------------------------ cards and payments

@router.post("/cards/tokens", response_model=TokenisedCard, status_code=201, tags=["payments"])
def tokenise(body: TokeniseIn, user: User = Depends(current_user), session: Session = Depends(get_session)):
    """Simulates the gateway's tokenisation endpoint. The number and CVC are checked and then dropped."""
    tok = services.tokenise(session, user, body.number, body.exp_month, body.exp_year, body.cvc)
    session.commit()
    return tok


@router.post("/payments", status_code=201, tags=["payments"])
def create_payment(body: PaymentIn, user: User = Depends(current_user), key: str | None = IdemKey,
                   lose: str | None = LostResponse, session: Session = Depends(get_session)):
    def action():
        return 201, services.payment_dict(services.create_payment(session, user, body.order_id, body.card_token))

    return idempotent_response(*run_once(session, user_id=user.id, key=key, scope="POST /api/payments", body=body.model_dump(), action=action), lose)


@router.post("/payments/{payment_id}/confirm", tags=["payments"])
def confirm(payment_id: str, body: ConfirmIn, user: User = Depends(current_user), key: str | None = IdemKey,
            session: Session = Depends(get_session)):
    def action():
        p = services.confirm_3ds(session, user, payment_id, body.otp)
        if p.status == "canceled":
            return 409, {"detail": "This order has already been paid.", "code": "order_already_paid"}
        return 200, services.payment_dict(p)

    scope = f"POST /api/payments/{payment_id}/confirm"
    return idempotent_response(*run_once(session, user_id=user.id, key=key, scope=scope, body=body.model_dump(), action=action))


@router.get("/payments/{payment_id}", tags=["payments"])
def get_payment(payment_id: str, user: User = Depends(current_user), session: Session = Depends(get_session)):
    p = session.get(Payment, payment_id)
    if p is None or (p.user_id != user.id and user.role != "merchant"):
        raise ApiError(404, "Payment not found.", "payment_not_found")
    return services.payment_dict(p)
