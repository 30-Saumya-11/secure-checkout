// Customer pages: shop, cart, sign-in, order history and receipts. Checkout has its own file.

import { useId, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { DEMO_PASSWORD } from "../api/demoApi";
import type { Product } from "../api/types";
import { formatAmount } from "../lib/gateway";
import { useApp, useLoad } from "../state";

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="card loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {what}…
    </div>
  );
}

export function ErrorNote({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="card error-card" role="alert">
      <p>{message}</p>
      {retry && (
        <button type="button" className="secondary small" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "Awaiting payment",
  paid: "Paid",
  refunded: "Refunded",
  succeeded: "Succeeded",
  partially_refunded: "Partly refunded",
  failed: "Failed",
  requires_action: "Awaiting 3-D Secure",
  canceled: "Canceled",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ------------------------------------------------------------------ shop

export function StorePage() {
  const { api, addToCart, cart } = useApp();
  const products = useLoad(() => api.products(), [api]);
  const [added, setAdded] = useState("");

  return (
    <>
      <section className="hero card">
        <div>
          <h1>Campus Store</h1>
          <p className="muted">Official merchandise. Secure card checkout with 3-D Secure; retrying a payment never charges you twice.</p>
        </div>
        <Link to="/cart" className="button-link">
          View cart ({cart.reduce((s, l) => s + l.quantity, 0)})
        </Link>
      </section>
      <p role="status" aria-live="polite" className="visually-hidden">
        {added}
      </p>
      {products.loading && !products.data && <Loading what="Loading products" />}
      {products.error && <ErrorNote message={products.error} retry={products.reload} />}
      <ul className="grid" aria-label="Products">
        {products.data?.map((p: Product) => (
          <li key={p.id} className="card product">
            <span className="product-thumb" aria-hidden="true">
              {p.emoji}
            </span>
            <h2>{p.name}</h2>
            <p className="muted">{p.description}</p>
            <div className="product-foot">
              <strong>{formatAmount(p.price_minor)}</strong>
              <button
                type="button"
                className="small"
                onClick={() => {
                  addToCart(p.id);
                  setAdded(`${p.name} added to cart`);
                }}
                aria-label={`Add ${p.name} to cart`}
              >
                Add to cart
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ cart

export function CartPage() {
  const { api, cart, setQuantity, user } = useApp();
  const products = useLoad(() => api.products(), [api]);
  const byId = new Map(products.data?.map((p) => [p.id, p]));
  const lines = cart.filter((l) => byId.has(l.productId));
  const total = lines.reduce((s, l) => s + byId.get(l.productId)!.price_minor * l.quantity, 0);

  if (products.loading && !products.data) return <Loading what="Loading your cart" />;
  if (products.error) return <ErrorNote message={products.error} retry={products.reload} />;
  return (
    <>
      <h1>Your cart</h1>
      {lines.length === 0 ? (
        <div className="card empty">
          <span className="empty-icon" aria-hidden="true">🛒</span>
          <p>Your cart is empty.</p>
          <Link to="/">Continue shopping</Link>
        </div>
      ) : (
        <div className="layout">
          <section className="card" aria-label="Items">
            <ul className="lines">
              {lines.map((l) => {
                const p = byId.get(l.productId)!;
                return (
                  <li key={l.productId} className="line">
                    <span className="thumb" aria-hidden="true">
                      {p.emoji}
                    </span>
                    <div className="line-name">
                      <p className="item-name">{p.name}</p>
                      <p className="muted">{formatAmount(p.price_minor)} each</p>
                    </div>
                    <div className="qty" role="group" aria-label={`Quantity of ${p.name}`}>
                      <button type="button" className="secondary icon" onClick={() => setQuantity(p.id, l.quantity - 1)} aria-label={`One less ${p.name}`}>
                        −
                      </button>
                      <span aria-live="polite">{l.quantity}</span>
                      <button type="button" className="secondary icon" onClick={() => setQuantity(p.id, l.quantity + 1)} aria-label={`One more ${p.name}`}>
                        +
                      </button>
                    </div>
                    <strong className="line-total">{formatAmount(p.price_minor * l.quantity)}</strong>
                  </li>
                );
              })}
            </ul>
          </section>
          <aside className="card">
            <h2>Summary</h2>
            <p className="total">
              <span>Total</span> <strong>{formatAmount(total)}</strong>
            </p>
            <p className="muted small-text">The final price is calculated by the server when you check out.</p>
            <Link to={user ? "/checkout" : "/login?next=/checkout"} className="button-link block">
              {user ? "Checkout" : "Sign in to check out"}
            </Link>
          </aside>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ sign in

export function LoginPage() {
  const { login, api } = useApp();
  const navigate = useNavigate();
  const next = new URLSearchParams(useLocation().search).get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const uid = useId();

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError("");
    try {
      const u = await login(e, p);
      // only follow local paths, never a full URL from the query string (open redirect)
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : u.role === "merchant" ? "/merchant" : "/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="narrow">
      <section className="card" aria-labelledby={`${uid}-h`}>
        <h1 id={`${uid}-h`}>Sign in</h1>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor={`${uid}-e`}>Email</label>
            <input id={`${uid}-e`} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-p`}>Password</label>
            <input id={`${uid}-p`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="demo-accounts">
          <p className="muted">Demo accounts{api.mode === "api" ? " (created by the seed script)" : ""}:</p>
          <div className="row">
            <button type="button" className="secondary" disabled={busy} onClick={() => signIn("customer@campus.store", DEMO_PASSWORD)}>
              Shop as a customer
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => signIn("merchant@campus.store", DEMO_PASSWORD)}>
              Open the merchant dashboard
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ orders

export function OrdersPage() {
  const { api } = useApp();
  const orders = useLoad(() => api.orders(), [api]);
  if (orders.loading && !orders.data) return <Loading what="Loading your orders" />;
  if (orders.error) return <ErrorNote message={orders.error} retry={orders.reload} />;
  return (
    <>
      <h1>My orders</h1>
      {orders.data!.length === 0 ? (
        <div className="card empty">
          <span className="empty-icon" aria-hidden="true">🧾</span>
          <p>No orders yet.</p>
          <Link to="/">Start shopping</Link>
        </div>
      ) : (
        <ul className="stack" aria-label="Orders">
          {orders.data!.map((o) => (
            <li key={o.id} className="card order-row">
              <div>
                <Link to={`/orders/${o.id}`} className="item-name">
                  Order {o.id}
                </Link>
                <p className="muted">
                  {when(o.created_at)} · {o.items.reduce((s, i) => s + i.quantity, 0)} item(s)
                </p>
              </div>
              <StatusPill status={o.status} />
              <strong>{formatAmount(o.total_minor)}</strong>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function OrderPage() {
  const { api } = useApp();
  const { id = "" } = useParams();
  const order = useLoad(() => api.order(id), [api, id]);
  if (order.loading && !order.data) return <Loading what="Loading the receipt" />;
  if (order.error) return <ErrorNote message={order.error} retry={order.reload} />;
  const o = order.data!;
  const paid = o.payments?.find((p) => ["succeeded", "partially_refunded", "refunded"].includes(p.status));
  return (
    <div className="narrow">
      <section className="card receipt" aria-labelledby="receipt-h">
        <div className="receipt-head">
          <h1 id="receipt-h">Receipt</h1>
          <StatusPill status={o.status} />
        </div>
        <p className="muted">
          Order {o.id} · {when(o.created_at)}
        </p>
        <table className="table">
          <caption className="visually-hidden">Items</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Qty</th>
              <th scope="col" className="num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((i) => (
              <tr key={i.product_id}>
                <td>{i.name}</td>
                <td>{i.quantity}</td>
                <td className="num">{formatAmount(i.unit_price_minor * i.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="total">
          <span>Total</span> <strong>{formatAmount(o.total_minor)}</strong>
        </p>
        {paid && (
          <p className="muted">
            Paid with {paid.brand} •••• {paid.last4} · payment {paid.id}
            {paid.amount_refunded_minor > 0 && ` · ${formatAmount(paid.amount_refunded_minor)} refunded`}
          </p>
        )}
        <Link to="/orders">← All orders</Link>
      </section>
    </div>
  );
}
