// Merchant pages: dashboard, transactions, payment detail (with refunds) and webhook deliveries.

import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { DECLINE_LABEL, DeclineBars, RevenueChart } from "../components/Charts";
import type { Delivery, Payment } from "../api/types";
import { formatAmount, newIdempotencyKey } from "../lib/gateway";
import { useApp, useLoad } from "../state";
import { ErrorNote, Loading, StatusPill, when } from "./customer";

const PERIODS = [7, 14, 30];

export function DashboardPage() {
  const { api } = useApp();
  const [days, setDays] = useState(14);
  const data = useLoad(() => Promise.all([api.summary(days), api.timeseries(days), api.declines(days), api.payments({ limit: 6 })]), [api, days]);

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map((d) => (
            <button key={d} type="button" className={d === days ? "on" : ""} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      {api.mode === "demo" && <p className="muted">Simulated history plus the payments you make in this tab.</p>}
      {data.error && <ErrorNote message={data.error} retry={data.reload} />}
      {!data.data && !data.error && <Loading what="Loading the dashboard" />}
      {data.data &&
        (() => {
          const [s, series, declines, recent] = data.data;
          return (
            <>
              <div className="kpis" aria-label="Key numbers">
                <Kpi label="Net revenue" value={formatAmount(s.net_minor)} note={`${formatAmount(s.gross_minor)} captured, ${formatAmount(s.refunded_minor)} refunded`} />
                <Kpi label="Success rate" value={s.success_rate === null ? "–" : `${(s.success_rate * 100).toFixed(1)}%`} note={`${s.payments} of ${s.attempts} payment attempts`} />
                <Kpi label="Average ticket" value={formatAmount(s.avg_ticket_minor)} note="per successful payment" />
                <Kpi label="Blocked by fraud rule" value={String(s.blocked_by_fraud_rule)} note="repeated declines on one card" />
              </div>
              <div className="layout">
                <section className="card" aria-labelledby="rev-h">
                  <h2 id="rev-h">Revenue</h2>
                  <RevenueChart points={series} />
                </section>
                <section className="card" aria-labelledby="dec-h">
                  <h2 id="dec-h">Why payments failed</h2>
                  <DeclineBars rows={declines} />
                </section>
              </div>
              <section className="card" aria-labelledby="recent-h">
                <div className="page-head">
                  <h2 id="recent-h">Recent payments</h2>
                  <Link to="/merchant/payments">All payments →</Link>
                </div>
                <PaymentTable items={recent.items} />
              </section>
            </>
          );
        })()}
    </>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      <span className="muted">{note}</span>
    </div>
  );
}

function PaymentTable({ items }: { items: Payment[] }) {
  if (!items.length) return <p className="muted">No payments match.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Payment</th>
            <th scope="col" className="hide-sm">Customer</th>
            <th scope="col" className="hide-sm">Card</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col" className="hide-sm">Date</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>
                <Link to={`/merchant/payments/${p.id}`}>{p.id}</Link>
              </td>
              <td className="hide-sm">{p.customer_email}</td>
              <td className="hide-sm">
                {p.brand} •••• {p.last4}
              </td>
              <td>
                <StatusPill status={p.status} />
                {p.decline_code && <span className="muted small-text hide-sm"> {DECLINE_LABEL[p.decline_code] ?? p.decline_code}</span>}
              </td>
              <td className="num">{formatAmount(p.amount_minor)}</td>
              <td className="hide-sm">{when(p.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ transactions

const PAGE = 20;

export function PaymentsPage() {
  const { api } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const brand = params.get("brand") ?? "";
  const offset = Number(params.get("offset") ?? 0);
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const page = useLoad(() => api.payments({ q, status, brand, limit: PAGE, offset }), [api, q, status, brand, offset]);
  const uid = useId();

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "offset") next.delete("offset");
    setParams(next);
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    set("q", draft.trim());
  };

  return (
    <>
      <h1>Payments</h1>
      <form className="card filters" onSubmit={search} role="search">
        <div className="field grow">
          <label htmlFor={`${uid}-q`}>Search</label>
          <input id={`${uid}-q`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Payment or order id, customer email, last 4 digits" />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-s`}>Status</label>
          <select id={`${uid}-s`} value={status} onChange={(e) => set("status", e.target.value)}>
            <option value="">All</option>
            <option value="succeeded">Succeeded</option>
            <option value="partially_refunded">Partly refunded</option>
            <option value="refunded">Refunded</option>
            <option value="failed">Failed</option>
            <option value="requires_action">Awaiting 3-D Secure</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-b`}>Card</label>
          <select id={`${uid}-b`} value={brand} onChange={(e) => set("brand", e.target.value)}>
            <option value="">All</option>
            <option value="visa">Visa</option>
            <option value="mastercard">Mastercard</option>
            <option value="rupay">RuPay</option>
            <option value="amex">Amex</option>
          </select>
        </div>
        <button type="submit" className="small align-end">
          Search
        </button>
      </form>
      {page.error && <ErrorNote message={page.error} retry={page.reload} />}
      {!page.data && !page.error && <Loading what="Loading payments" />}
      {page.data && (
        <section className="card" aria-label="Results">
          <p className="muted" role="status">
            {page.data.total} payment{page.data.total === 1 ? "" : "s"}
          </p>
          <PaymentTable items={page.data.items} />
          <div className="pager">
            <button type="button" className="secondary small" disabled={offset === 0} onClick={() => set("offset", String(Math.max(0, offset - PAGE)))}>
              ← Newer
            </button>
            <span className="muted">
              {page.data.total ? `${offset + 1}–${Math.min(offset + PAGE, page.data.total)}` : "0"} of {page.data.total}
            </span>
            <button type="button" className="secondary small" disabled={offset + PAGE >= page.data.total} onClick={() => set("offset", String(offset + PAGE))}>
              Older →
            </button>
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ payment detail

export function PaymentDetailPage() {
  const { api } = useApp();
  const { id = "" } = useParams();
  const detail = useLoad(() => api.payment(id), [api, id]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey); // one key per refund attempt; a retry of the same form reuses it
  const uid = useId();

  if (detail.error) return <ErrorNote message={detail.error} retry={detail.reload} />;
  if (!detail.data) return <Loading what="Loading the payment" />;
  const p = detail.data;
  const left = p.amount_minor - p.amount_refunded_minor;
  const refundable = (p.status === "succeeded" || p.status === "partially_refunded") && left > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const rupees = amount.trim();
    let minor: number | undefined;
    if (rupees) {
      minor = Math.round(Number(rupees) * 100);
      if (!Number.isFinite(minor) || minor <= 0) return setMsg({ ok: false, text: "Enter an amount in rupees, e.g. 499 or 499.50." });
      if (minor > left) return setMsg({ ok: false, text: `At most ${formatAmount(left)} can be refunded.` });
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.refund(p.id, minor, reason.trim(), key);
      setMsg({ ok: true, text: `Refunded ${formatAmount(minor ?? left)}.` });
      setAmount("");
      setReason("");
      setKey(newIdempotencyKey()); // done: the next refund is a new attempt
      detail.reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <Link to="/merchant/payments">← Payments</Link>
      </p>
      <div className="page-head">
        <h1>
          {formatAmount(p.amount_minor)} <span className="muted id">{p.id}</span>
        </h1>
        <StatusPill status={p.status} />
      </div>
      <div className="layout">
        <div className="main-col">
          <section className="card" aria-labelledby={`${uid}-tl`}>
            <h2 id={`${uid}-tl`}>Timeline</h2>
            <ol className="timeline">
              {p.events.map((e, i) => (
                <li key={i} className={`tl-${e.type.split(".")[1] ?? "x"}`}>
                  <span className="tl-dot" aria-hidden="true" />
                  <div>
                    <p className="item-name">{e.type}</p>
                    <p className="muted">
                      {e.detail} · {when(e.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <section className="card" aria-labelledby={`${uid}-wh`}>
            <h2 id={`${uid}-wh`}>Webhooks for this payment</h2>
            {p.webhooks.length ? <DeliveryTable rows={p.webhooks} showPayment={false} /> : <p className="muted">No webhook deliveries{api.mode === "demo" ? " (webhooks need the backend)" : ""}.</p>}
          </section>
        </div>
        <aside className="side-col">
          <section className="card" aria-labelledby={`${uid}-d`}>
            <h2 id={`${uid}-d`}>Details</h2>
            <dl className="facts">
              <dt>Customer</dt>
              <dd>{p.customer.email}</dd>
              <dt>Card</dt>
              <dd>
                {p.brand} •••• {p.last4}
              </dd>
              <dt>Order</dt>
              <dd>{p.order.id}</dd>
              <dt>Items</dt>
              <dd>{p.order.items.map((i) => `${i.name} × ${i.quantity}`).join(", ")}</dd>
              {p.decline_code && (
                <>
                  <dt>Failure</dt>
                  <dd>{DECLINE_LABEL[p.decline_code] ?? p.decline_code}</dd>
                </>
              )}
              <dt>Refunded</dt>
              <dd>{formatAmount(p.amount_refunded_minor)}</dd>
            </dl>
          </section>
          <section className="card" aria-labelledby={`${uid}-r`}>
            <h2 id={`${uid}-r`}>Refund</h2>
            {refundable ? (
              <form onSubmit={submit} noValidate>
                <div className="field">
                  <label htmlFor={`${uid}-amt`}>Amount in ₹ (empty = the full {formatAmount(left)})</label>
                  <input id={`${uid}-amt`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={(left / 100).toFixed(2)} />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-why`}>Reason (optional)</label>
                  <input id={`${uid}-why`} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
                </div>
                <button type="submit" disabled={busy}>
                  {busy ? "Refunding…" : "Refund"}
                </button>
              </form>
            ) : (
              <p className="muted">{left === 0 && p.amount_refunded_minor > 0 ? "Fully refunded." : "Only successful payments can be refunded."}</p>
            )}
            <p role="status" aria-live="polite" className={msg?.ok === false ? "error" : "ok"}>
              {msg?.text}
            </p>
            {p.refunds.length > 0 && (
              <ul className="muted refunds">
                {p.refunds.map((r) => (
                  <li key={r.id}>
                    {formatAmount(r.amount_minor)} · {when(r.created_at)}
                    {r.reason && ` · ${r.reason}`}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ webhooks

function DeliveryTable({ rows, onRetry, showPayment = true }: { rows: Delivery[]; onRetry?: (id: number) => void; showPayment?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Event</th>
            {showPayment && <th scope="col">Payment</th>}
            <th scope="col">Status</th>
            <th scope="col" className="hide-sm">Attempts</th>
            <th scope="col">Last response</th>
            <th scope="col" className="hide-sm">Created</th>
            {onRetry && <th scope="col">Action</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td>{d.event_type}</td>
              {showPayment && <td>{d.payment_id ? <Link to={`/merchant/payments/${d.payment_id}`}>{d.payment_id}</Link> : "–"}</td>}
              <td>
                <span className={`pill pill-wh-${d.status}`}>{d.status}</span>
              </td>
              <td className="hide-sm">{d.attempts}</td>
              <td>{d.last_status_code ?? (d.last_error ? "error" : "–")}</td>
              <td className="hide-sm">{when(d.created_at)}</td>
              {onRetry && (
                <td>
                  {d.status === "failed" && (
                    <button type="button" className="secondary small" onClick={() => onRetry(d.id)}>
                      Retry
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WebhooksPage() {
  const { api } = useApp();
  const data = useLoad(() => api.webhooks(), [api]);
  const retry = async (id: number) => {
    await api.retryDelivery(id);
    data.reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Webhooks</h1>
        <button type="button" className="secondary small" onClick={data.reload}>
          Refresh
        </button>
      </div>
      <section className="card">
        <h2>How it works</h2>
        <p className="muted">
          Every payment and refund queues an event in the same database transaction. A background worker POSTs it to the endpoint
          with a <code>Campus-Signature</code> header (HMAC-SHA256 of the timestamp and body). Failed deliveries are retried after 30
          s, 1, 2, 4 and 8 minutes, then marked failed and can be retried by hand.
        </p>
      </section>
      {data.error && <ErrorNote message={data.error} retry={data.reload} />}
      {!data.data && !data.error && <Loading what="Loading webhooks" />}
      {data.data && data.data.endpoint && data.data.deliveries.length === 0 && (
        <p className="card empty">No deliveries yet: they appear after the next payment or refund.</p>
      )}
      {data.data && (
        <>
          {data.data.endpoint ? (
            <div className="kpis">
              <div className="card kpi wide">
                <span className="kpi-label">Endpoint</span>
                <code className="endpoint">{data.data.endpoint.url}</code>
                <span className="muted">Secret {data.data.endpoint.secret_hint}</span>
              </div>
              {(["delivered", "pending", "failed"] as const).map((s) => (
                <div className="card kpi" key={s}>
                  <span className="kpi-label">{s}</span>
                  <strong className="kpi-value">{data.data!.counts[s] ?? 0}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="card muted">
              {api.mode === "demo" ? "Webhooks are sent by the backend, so there is nothing to show in demo mode." : "No endpoint configured."}
            </p>
          )}
          {data.data.deliveries.length > 0 && (
            <section className="card" aria-label="Deliveries">
              <h2>Recent deliveries</h2>
              <DeliveryTable rows={data.data.deliveries} onRetry={retry} />
            </section>
          )}
        </>
      )}
    </>
  );
}
