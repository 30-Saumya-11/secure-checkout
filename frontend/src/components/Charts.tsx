// Two small hand-written SVG charts (no chart library to load). Each has a text alternative for screen readers.

import { formatAmount } from "../lib/gateway";
import type { DayPoint, DeclineCount } from "../api/types";

const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** Revenue per day (bars) with failed payments marked underneath. */
export function RevenueChart({ points }: { points: DayPoint[] }) {
  const W = 640;
  const H = 220;
  const pad = { l: 8, r: 8, t: 12, b: 42 };
  const max = Math.max(1, ...points.map((p) => p.captured_minor));
  const bw = (W - pad.l - pad.r) / Math.max(1, points.length);
  const total = points.reduce((s, p) => s + p.captured_minor, 0);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Revenue per day for the last ${points.length} days, ${formatAmount(total)} in total`}>
        <defs>
          <linearGradient id="bar-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6d28d9" />
            <stop offset="100%" stopColor="#1e40af" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + (H - pad.t - pad.b) * (1 - f)} y2={pad.t + (H - pad.t - pad.b) * (1 - f)} className="grid" />
        ))}
        {points.map((p, i) => {
          const h = ((H - pad.t - pad.b) * p.captured_minor) / max;
          const x = pad.l + i * bw + bw * 0.15;
          return (
            <g key={p.date}>
              <rect x={x} y={H - pad.b - h} width={bw * 0.7} height={h} rx={4} className="bar" fill="url(#bar-fill)">
                <title>{`${shortDay(p.date)}: ${formatAmount(p.captured_minor)}, ${p.succeeded} paid, ${p.failed} failed`}</title>
              </rect>
              {p.failed > 0 && (
                <text x={x + bw * 0.35} y={H - pad.b + 14} className="fail-mark" textAnchor="middle">
                  {`✕${p.failed}`}
                </text>
              )}
              {(i % 2 === 0 || points.length <= 8) && (
                <text x={x + bw * 0.35} y={H - 8} className="axis" textAnchor="middle">
                  {shortDay(p.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted">Bars: captured revenue per day (Indian time). ✕n: failed payments that day.</figcaption>
    </figure>
  );
}

const DECLINE_LABEL: Record<string, string> = {
  card_declined: "Declined by bank",
  insufficient_funds: "Insufficient funds",
  authentication_failed: "3-D Secure failed",
  velocity_blocked: "Blocked by fraud rule",
  invalid_request: "Invalid request",
};

/** Horizontal bars: why payments failed. */
export function DeclineBars({ rows }: { rows: DeclineCount[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <p className="muted">No failed payments in this period.</p>;
  return (
    <ul className="hbars" aria-label="Failed payments by reason">
      {rows.map((r) => (
        <li key={r.code}>
          <span className="hbar-label">{DECLINE_LABEL[r.code] ?? r.code}</span>
          <span className="hbar-track" aria-hidden="true">
            <span className="hbar" style={{ width: `${(100 * r.count) / max}%` }} />
          </span>
          <span className="hbar-value">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

export { DECLINE_LABEL };
