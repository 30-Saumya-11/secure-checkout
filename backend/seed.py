"""Demo data:  python seed.py  (after `alembic upgrade head`).

Creates a merchant and a customer to sign in with, the product catalogue, a webhook endpoint, and --history days of
SIMULATED payments (made through the real payment code with test cards, then back-dated) so the dashboard has
something to show. Everything here is demo data; none of it is real customer activity.
"""

from __future__ import annotations

import argparse
import os
import random
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app import services
from app.db import SessionLocal
from app.models import Order, Payment, PaymentEvent, Product, User, WebhookEndpoint
from app.security import hash_password

PRODUCTS = [
    ("Campus hoodie", "Heavyweight cotton, embroidered crest", "👕", 249900),
    ("Notebook set", "Three ruled A5 notebooks", "📓", 34900),
    ("Coffee mug", "Ceramic, 350 ml", "☕", 29900),
    ("Laptop backpack", "Fits 15-inch laptops, water resistant", "🎒", 189900),
    ("Water bottle", "Steel, keeps drinks cold for 12 hours", "🧴", 59900),
    ("Baseball cap", "Adjustable, embroidered logo", "🧢", 44900),
]

# test cards and how often the simulated customers use them
CARDS = [("4242424242424242", 70), ("5555555555554444", 12), ("378282246310005", 5),
         ("4000000000000002", 6), ("4000000000009995", 5), ("4000000000003220", 2)]


def user(session, email: str, name: str, role: str, password: str) -> User:
    u = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if u is None:
        u = User(email=email, name=name, role=role, password_hash=hash_password(password))
        session.add(u)
        session.flush()
    return u


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", type=int, default=14, help="days of simulated payments (0 = none)")
    ap.add_argument("--per-day", type=int, default=9)
    a = ap.parse_args()
    password = os.environ.get("SEED_PASSWORD", "demo-password")  # demo accounts only
    # where the built-in webhook receiver is reachable (Render sets RENDER_EXTERNAL_URL itself)
    base_url = os.environ.get("PUBLIC_BASE_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "http://127.0.0.1:8101"
    rng = random.Random(7)  # fixed seed: the same demo data every time

    with SessionLocal() as s:
        if s.execute(select(Product)).first():
            print("already seeded")
            return
        merchant = user(s, "merchant@campus.store", "Store Manager", "merchant", password)
        user(s, "customer@campus.store", "Saumya (demo customer)", "customer", password)
        products = [Product(name=n, description=d, emoji=e, price_minor=p) for n, d, e, p in PRODUCTS]
        s.add_all(products)
        s.flush()
        shoppers = [user(s, f"demo-customer-{i}@example.com", f"Demo customer {i}", "customer", password) for i in range(1, 7)]

        now = datetime.now(timezone.utc)
        n = 0
        for day in range(a.history - 1, -1, -1):
            for _ in range(rng.randint(a.per_day - 3, a.per_day + 3)):
                when = now - timedelta(days=day, hours=rng.randint(0, 10), minutes=rng.randint(0, 59))
                if when > now:
                    continue
                shopper = rng.choice(shoppers)
                lines = [(p.id, rng.randint(1, 2)) for p in rng.sample(products, rng.randint(1, 3))]
                order = services.create_order(s, shopper, lines)
                card = rng.choices([c for c, _ in CARDS], weights=[w for _, w in CARDS])[0]
                cvc = "1234" if card.startswith("37") else "123"
                tok = services.tokenise(s, shopper, card, 12, now.year + 2, cvc)
                pay = services.create_payment(s, shopper, order.id, tok.token)
                if pay.status == "requires_action":
                    pay = services.confirm_3ds(s, shopper, pay.id, "123456" if rng.random() < 0.8 else "000000")
                # back-date this simulated payment (and its order and timeline) to its day
                pay.created_at = order.created_at = when
                for e in s.execute(select(PaymentEvent).where(PaymentEvent.payment_id == pay.id)).scalars():
                    e.at = when
                s.flush()
                n += 1
        # a few refunds so the dashboard shows them too
        paid = s.execute(select(Payment).where(Payment.status == "succeeded").order_by(Payment.created_at)).scalars().all()
        for p in rng.sample(paid, min(4, len(paid))):
            services.refund(s, merchant, p.id, None if rng.random() < 0.5 else p.amount_minor // 2, "Demo refund")

        # webhooks go to the built-in receiver (DEMO_TOOLS=true); created after the history so old payments are not sent
        s.add(WebhookEndpoint(url=f"{base_url}/api/dev/webhook-receiver", secret="whsec_" + secrets.token_hex(24)))
        s.commit()
        orders = s.execute(select(Order)).scalars().all()
        print(f"seeded: 2 sign-in accounts, {len(products)} products, {n} simulated payments over {a.history} days, {len(orders)} orders")
        print(f"sign in as merchant@campus.store or customer@campus.store with password: {password}")


if __name__ == "__main__":
    main()
