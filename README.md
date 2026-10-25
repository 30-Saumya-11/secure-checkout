# Campus Store Payments

A small online store with its own payments platform: customers shop and pay by card; the merchant sees revenue,
success rate and decline reasons, searches transactions, issues refunds and watches signed webhooks being delivered.

**React + TypeScript** frontend · **FastAPI** backend · **PostgreSQL** · Docker · GitHub Actions

**[Live demo →](https://30-saumya-11.github.io/secure-checkout/)** (demo mode: runs in the browser with a simulated
gateway; sign in with the "Open the merchant dashboard" button) · **[Full documentation (PDF)](docs/Secure_Checkout_Documentation.pdf)**

| Merchant dashboard | Checkout |
|---|---|
| ![Merchant dashboard with revenue chart and decline reasons](docs/screenshot-dashboard.png) | ![Accessible checkout form with order summary and payment help](docs/screenshot-checkout.png) |
| **Payment detail: timeline, refund, webhooks** | **Phone (375 px)** |
| ![Payment detail](docs/screenshot-payment-detail.png) | <img src="docs/screenshot-payments-mobile.png" alt="Payments list on a phone" width="240"> |

Demo only: no real card network is contacted. Payments in the screenshots are simulated with test cards.

## What it does

**Customer:** product catalogue → cart → sign-in → checkout (accessible card form, 3-D Secure, safe retries) →
order history and receipts. A help assistant answers payment questions from a help centre and cites its sources.

**Merchant:** dashboard (net revenue, success rate, average ticket, payments blocked by the fraud rule, revenue per
day, why payments failed), searchable and filterable transactions, payment detail with a timeline, full and partial
refunds, webhook delivery log with manual retry, audit log and per-route metrics in the API.

## Architecture

```mermaid
flowchart LR
  B[Browser<br/>React + Router] -->|JWT, Idempotency-Key| A[FastAPI]
  A --> S[services.py<br/>orders, payments, 3-D Secure,<br/>refunds, fraud rule]
  S --> G[gateway.py<br/>simulated gateway:<br/>tokenise, authorise]
  S -->|one transaction:<br/>action + key + audit + outbox| P[(PostgreSQL)]
  W[Webhook worker<br/>FOR UPDATE SKIP LOCKED] --> P
  W -->|HMAC-SHA256 signed POST,<br/>retries with back-off| M[Merchant endpoint]
```

```mermaid
sequenceDiagram
  participant C as Checkout (browser)
  participant API as FastAPI
  participant DB as Postgres
  C->>API: POST /api/cards/tokens (number, expiry, CVC)
  API-->>C: token, brand, last 4 (number and CVC are dropped)
  C->>API: POST /api/payments {order, token}, Idempotency-Key K
  API->>DB: INSERT key K, lock order, authorise, save payment + outbox, COMMIT
  API--xC: response lost (the card WAS charged)
  C->>API: retry, same body, same key K
  API->>DB: key K exists, same body
  API-->>C: the saved result (Idempotent-Replayed: true), no second charge
```

| Path | What |
|---|---|
| `backend/app/idempotency.py` | Idempotency keys stored in the same transaction as the action; replay or 409 on reuse |
| `backend/app/services.py` | Orders (prices from the database), payments, 3-D Secure, refunds with row locks, fraud rule, audit, webhook outbox |
| `backend/app/gateway.py` | Simulated gateway: Luhn, brand, expiry and CVC checks; tokenisation; test-card outcomes |
| `backend/app/webhooks.py` | Signing and verifying, delivery worker, exponential back-off |
| `backend/app/routes/` | Customer API (`store.py`), merchant API (`merchant.py`), demo tools (`dev.py`) |
| `backend/migrations/` | Alembic migration that creates the schema |
| `frontend/src/api/` | `HttpApi` + `ApiGateway` (real backend), `DemoApi` (in-browser stand-in for the static demo) |
| `frontend/src/pages/` | Store, cart, checkout, orders, sign-in, dashboard, payments, payment detail, webhooks |
| `frontend/src/components/` | Accessible `CheckoutForm`, 3-D Secure dialog, help assistant, SVG charts |

## Rules it enforces

| Rule | How | Tested by |
|---|---|---|
| A retry never charges twice | `Idempotency-Key` required on orders, payments, 3-D Secure confirmations and refunds; key and action commit together | 6 identical requests at once → 1 payment |
| One order is paid once | `SELECT … FOR UPDATE` on the order row | 5 payments for one order at once → 1 succeeds, 4 get 409 |
| Refunds never exceed the payment | Row lock on the payment, plus a database `CHECK` constraint | 5 refunds of ₹1,000 on a ₹2,499 payment at once → exactly 2 succeed |
| No card numbers or CVCs stored | Only token, brand, last 4, expiry and a keyed fingerprint (HMAC) | a test searches every table for the number |
| A late 3-D Secure cannot double-charge | If the order was already paid another way, the old attempt is canceled | yes |
| Fraud rule | 3 declines for the same card fingerprint in 10 minutes block further attempts (no issuer call) | yes, including the time window |
| Prices come from the server | Orders take product ids and quantities only | a test sends a fake total |
| Roles | Customers see only their own orders and payments; merchant endpoints return 403 to customers | yes |
| Webhooks are authentic | `Campus-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`; receivers reject old timestamps | tampered body, wrong secret, replay |

## Run it

**Everything with Docker** (Postgres, API, web app behind nginx):

```bash
cp .env.example .env        # fill in the secrets
docker compose up --build   # http://localhost:8080
```

**Without Docker** (Python 3.12, Node 22, a Postgres you can reach):

```bash
cd backend
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql://user:pass@localhost:5432/store JWT_SECRET=... CARD_FINGERPRINT_KEY=... DEMO_TOOLS=true
alembic upgrade head && python seed.py      # demo accounts, products, 14 days of SIMULATED payments
uvicorn app.main:app --port 8101            # API docs: http://127.0.0.1:8101/docs
python -m pytest -q                         # 36 tests; starts a throwaway Postgres (pgserver) if DATABASE_URL is unset

cd ../frontend
npm install
VITE_API_URL=http://127.0.0.1:8101 npm run dev -- --port 5181
npm test                                    # 73 tests
```

Without `VITE_API_URL` the frontend runs in **demo mode** (this is what GitHub Pages serves).
Demo accounts: `customer@campus.store` and `merchant@campus.store`, password `demo-password` (set `SEED_PASSWORD`
to change it). Test cards: `4242 4242 4242 4242` succeeds · `4000 0000 0000 0002` declined ·
`4000 0000 0000 9995` insufficient funds · `4000 0000 0000 3220` asks for 3-D Secure (code `123456`).

**Deploy:** `render.yaml` is a Render blueprint (Postgres + API + static site). Set `VITE_API_URL` on the static site
and `CORS_ORIGINS` on the API to each other's URLs.

## Testing

| Suite | Count | Covers |
|---|---|---|
| `backend/tests/test_payments.py` | 14 | idempotency (incl. concurrent duplicates), lost responses, declines, 3-D Secure, abandoned 3-D Secure, fraud rule, card data never stored |
| `backend/tests/test_refunds_auth.py` | 12 | partial/full refunds, over-limit, concurrent refunds, roles, ownership, sign-in, forged tokens |
| `backend/tests/test_webhooks_dashboard.py` | 10 | signatures, retries with back-off, giving up, manual retry, dashboard numbers, search, metrics, audit |
| `frontend/src/pages/pages.test.tsx` | 10 | cart, sign-in redirect, pay → receipt, role guards, dashboard (with axe check), filters, refunds |
| `frontend/src/api/httpApi.test.ts` | 7 | client retries, one token per attempt, error mapping, session expiry |
| earlier frontend suites | 56 | card rules, gateway, form accessibility, assistant and its evaluation |

Backend tests run against a real Postgres (CI uses a Postgres service container), because row locks,
`ON CONFLICT` and JSONB behave differently in SQLite.

## Payment help assistant (RAG)

10 help articles (21 sections), BM25 retrieval with synonyms and light stemming, the last decline code added as
context, a refusal threshold (2.25) chosen on dev questions only. On 20 held-out test questions: right article first
14/16, in the top 3 15/16, out-of-scope refused 3/4, in-scope wrongly refused 0/16. The articles and questions were
written by the same person and the set is small, so these numbers are optimistic.

## Limitations

- The gateway is simulated. A real store would use a payment provider's hosted fields, so card data never reaches
  this server at all (smaller PCI DSS scope); here the backend sees the number once, during tokenisation.
- The session token is kept in `localStorage` (readable by any script on the page); an `httpOnly` cookie with CSRF
  protection would be safer.
- Metrics are in-process counters; production would export them (e.g. Prometheus).
- The dashboard's history is simulated by the seed script; the demo has no real customers.
- The fraud rule is one fixed rule, not a model.

## Things to be ready to explain

- Why the idempotency key is stored in the same transaction as the payment, and what Postgres does when two
  requests insert the same key at once.
- Why `SELECT … FOR UPDATE` on the payment makes concurrent refunds safe, and why the `CHECK` constraint is still there.
- How the webhook signature is built and checked, why it includes a timestamp, and why retries keep the same event id.
- Why the outbox row is written in the payment transaction instead of sending the webhook inside the request.
- Why the browser never decides the price, and why the card token is reused for retries.
- What `FOR UPDATE SKIP LOCKED` does for several webhook workers.
