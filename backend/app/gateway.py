"""Simulated card gateway (server-side port of frontend/src/lib/gateway.ts).

Two steps, like real gateways:
1. tokenise(): checks the card (Luhn, brand, expiry, CVC length), then forgets the number and the CVC. It returns a
   random token plus what is safe to keep: brand, last 4 digits, expiry and a keyed fingerprint (HMAC-SHA256 of the
   number) so the fraud rule can recognise the same card without knowing it.
2. authorise(): decides the issuer's answer for a token. Test cards map to fixed answers; any other valid card is
   approved. Demo only: no card network is contacted.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import date

from .config import settings

TEST_OTP = "123456"

# test card -> simulated issuer behaviour (the same cards as the frontend demo)
TEST_CARDS = {
    "4000000000000002": "decline:card_declined",
    "4000000000009995": "decline:insufficient_funds",
    "4000000000003220": "requires_3ds",
}

DECLINE_MESSAGES = {
    "card_declined": "Your card was declined.",
    "insufficient_funds": "Your card has insufficient funds.",
    "authentication_failed": "The verification code was incorrect.",
    "velocity_blocked": "Too many failed attempts with this card. Please wait or use a different card.",
}

# brand, prefix ranges (inclusive, same digit count), allowed lengths, CVC length
_RULES = [
    ("amex", [(34, 34), (37, 37)], (15,), 4),
    ("mastercard", [(51, 55), (2221, 2720)], (16,), 3),
    ("rupay", [(508500, 508999), (606985, 607984), (608001, 608500), (652150, 653149)], (16,), 3),
    ("visa", [(4, 4)], (13, 16, 19), 3),
]


class CardError(ValueError):
    """The card details are invalid (shown to the customer as a 422)."""


def luhn_valid(digits: str) -> bool:
    if len(digits) < 12 or not digits.isdigit():
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def detect_brand(digits: str) -> tuple[str, tuple[int, ...], int]:
    for brand, ranges, lengths, cvc_len in _RULES:
        for lo, hi in ranges:
            n = len(str(lo))
            if len(digits) >= n and lo <= int(digits[:n]) <= hi:
                return brand, lengths, cvc_len
    return "unknown", (12, 13, 14, 15, 16, 17, 18, 19), 3


def fingerprint(digits: str) -> str:
    # keyed, so a leaked database cannot be reversed by hashing every possible card number
    return hmac.new(settings.card_fingerprint_key.encode(), digits.encode(), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class CheckedCard:
    brand: str
    last4: str
    exp_month: int
    exp_year: int
    fingerprint: str
    test_behaviour: str


def check_card(number: str, exp_month: int, exp_year: int, cvc: str, today: date | None = None) -> CheckedCard:
    """Validate and reduce a card to what may be stored. The full number and CVC do not leave this function."""
    digits = "".join(ch for ch in number if ch.isdigit())
    if not luhn_valid(digits):
        raise CardError("The card number is not valid.")
    brand, lengths, cvc_len = detect_brand(digits)
    if len(digits) not in lengths:
        raise CardError("The card number has the wrong length for this card type.")
    if not (1 <= exp_month <= 12):
        raise CardError("The expiry month is not valid.")
    today = today or date.today()
    # a card is valid until the end of its expiry month
    if (exp_year, exp_month) < (today.year, today.month):
        raise CardError("The card has expired.")
    if not (cvc.isdigit() and len(cvc) == cvc_len):
        raise CardError(f"The security code must be {cvc_len} digits.")
    return CheckedCard(brand, digits[-4:], exp_month, exp_year, fingerprint(digits), TEST_CARDS.get(digits, "approve"))


@dataclass(frozen=True)
class Authorisation:
    status: str  # succeeded | requires_action | failed
    decline_code: str | None = None


def authorise(test_behaviour: str, amount_minor: int) -> Authorisation:
    if amount_minor <= 0:
        return Authorisation("failed", "invalid_request")
    if test_behaviour.startswith("decline:"):
        return Authorisation("failed", test_behaviour.split(":", 1)[1])
    if test_behaviour == "requires_3ds":
        return Authorisation("requires_action")
    return Authorisation("succeeded")
