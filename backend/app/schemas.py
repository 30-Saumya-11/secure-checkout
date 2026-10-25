"""Request bodies (validated before any SQL runs) and response shapes."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class RegisterIn(BaseModel):
    email: str = Field(max_length=254, pattern=EMAIL_RE)
    name: str = Field(min_length=2, max_length=100)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def lower(cls, v: str) -> str:
        return v.strip().lower()


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    name: str
    role: str


class TokenOut(BaseModel):
    token: str
    user: UserOut


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=500)
    emoji: str = Field(default="🛍️", max_length=8)
    price_minor: int = Field(gt=0, le=10_000_000)


class ProductPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    price_minor: int | None = Field(default=None, gt=0, le=10_000_000)
    active: bool | None = None


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: str
    emoji: str
    price_minor: int
    active: bool


class CartLine(BaseModel):
    product_id: int
    quantity: int = Field(ge=1, le=20)


class OrderIn(BaseModel):
    # only product ids and quantities: prices always come from the database, never from the browser
    items: list[CartLine] = Field(min_length=1, max_length=50)


class TokeniseIn(BaseModel):
    number: str = Field(min_length=12, max_length=23)
    exp_month: int
    exp_year: int = Field(ge=2000, le=2100)
    cvc: str = Field(min_length=3, max_length=4)
    name: str = Field(min_length=2, max_length=100)


class TokenisedCard(BaseModel):
    token: str
    brand: str
    last4: str
    exp_month: int
    exp_year: int


class PaymentIn(BaseModel):
    order_id: str = Field(max_length=24)
    card_token: str = Field(max_length=32)


class ConfirmIn(BaseModel):
    otp: str = Field(min_length=4, max_length=10)


class RefundIn(BaseModel):
    amount_minor: int | None = Field(default=None, gt=0)  # empty = refund everything that is left
    reason: str = Field(default="", max_length=200)


class WebhookEndpointIn(BaseModel):
    url: str = Field(max_length=500, pattern=r"^https?://\S+$")
    active: bool = True


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    type: str
    detail: str
    at: datetime
