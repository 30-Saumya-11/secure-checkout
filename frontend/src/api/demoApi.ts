// Demo mode: an in-browser stand-in for the backend, used when no VITE_API_URL is set (the GitHub Pages demo).
// Payments go through MockGateway (same test cards, idempotency and lost-response simulation); the merchant pages
// show 14 days of SIMULATED history plus whatever you pay in this tab. Nothing is saved and nothing is real.
// The real rules (row locks, idempotency in the database, webhooks) live in backend/app.

import { MockGateway, formatAmount, type ChargeRequest, type ChargeResult, type PaymentGateway } from "../lib/gateway";
import {
  ApiError,
  type CartLine,
  type DayPoint,
  type DeclineCount,
  type Order,
  type Payment,
  type PaymentDetail,
  type PaymentPage,
  type PaymentQuery,
  type Product,
  type StoreApi,
  type Summary,
  type User,
  type WebhookOverview,
} from "./types";

export const DEMO_PASSWORD = "demo-password";

export const DEMO_PRODUCTS: Product[] = [
  { id: 1, name: "Campus hoodie", description: "Heavyweight cotton, embroidered crest", emoji: "👕", price_minor: 249900, active: true },
  { id: 2, name: "Notebook set", description: "Three ruled A5 notebooks", emoji: "📓", price_minor: 34900, active: true },
  { id: 3, name: "Coffee mug", description: "Ceramic, 350 ml", emoji: "☕", price_minor: 29900, active: true },
  { id: 4, name: "Laptop backpack", description: "Fits 15-inch laptops, water resistant", emoji: "🎒", price_minor: 189900, active: true },
  { id: 5, name: "Water bottle", description: "Steel, keeps drinks cold for 12 hours", emoji: "🧴", price_minor: 59900, active: true },
  { id: 6, name: "Baseball cap", description: "Adjustable, embroidered logo", emoji: "🧢", price_minor: 44900, active: true },
];

const USERS: User[] = [
  { id: 1, email: "merchant@campus.store", name: "Store Manager", role: "merchant" },
  { id: 2, email: "customer@campus.store", name: "Saumya (demo customer)", role: "customer" },
];

interface Record_ {
  payment: Payment;
  order: Order;
  customer: User;
  events: PaymentDetail["events"];
  refunds: PaymentDetail["refunds"];
}

const CAPTURED = ["succeeded", "partially_refunded", "refunded"];
const DAY = 86_400_000;

// small deterministic random generator, so the simulated history is the same on every visit
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export class DemoApi implements StoreApi {
  readonly mode = "demo" as const;
  private user: User | null = null;
  private readonly records: Record_[] = [];
  private readonly orderList: Order[] = [];
  private seq = 0;

  constructor(
    private readonly latencyMs = 150,
    history = true,
  ) {
    if (history) this.simulateHistory();
  }

  private wait<T>(v: T): Promise<T> {
    return new Promise((r) => setTimeout(() => r(v), this.latencyMs));
  }

  private needRole(role?: User["role"]) {
    if (!this.user) throw new ApiError(401, "Please sign in.");
    if (role && this.user.role !== role) throw new ApiError(403, "Only the merchant can do this.");
    return this.user;
  }

  async login(email: string, password: string) {
    const u = USERS.find((x) => x.email === email.trim().toLowerCase());
    if (!u || password !== DEMO_PASSWORD) throw new ApiError(401, "Wrong email or password.");
    this.user = u;
    return this.wait(u);
  }

  logout() {
    this.user = null;
  }

  async currentUser() {
    return this.user;
  }

  products = () => this.wait(DEMO_PRODUCTS);

  private readonly orderKeys = new Map<string, Order>();

  async createOrder(lines: CartLine[], key: string) {
    const u = this.needRole();
    const seen = this.orderKeys.get(key);
    if (seen) return this.wait(seen); // same Idempotency-Key: the same order, like the backend
    const items = lines.map((l) => {
      const p = DEMO_PRODUCTS.find((x) => x.id === l.productId);
      if (!p) throw new ApiError(422, "Product not available.");
      return { product_id: p.id, name: p.name, unit_price_minor: p.price_minor, quantity: l.quantity };
    });
    const order: Order = {
      id: `ord_demo${++this.seq}`,
      status: "pending",
      total_minor: items.reduce((s, i) => s + i.unit_price_minor * i.quantity, 0),
      currency: "INR",
      created_at: new Date().toISOString(),
      items,
    };
    this.orderList.unshift(order);
    this.orderKeys.set(key, order);
    this.ownerOf.set(order.id, u);
    return this.wait(order);
  }

  private readonly ownerOf = new Map<string, User>();
  private readonly gateway = new MockGateway(400);

  /** Wraps MockGateway and records what happened, so the merchant pages see this tab's payments too. */
  gatewayFor(order: Order): PaymentGateway {
    // a lost response throws before record(): the charge is recorded when the retry returns it
    const charge = async (req: ChargeRequest, key: string) => this.record(order, await this.gateway.charge(req, key), { req, key });
    const confirm3ds = async (id: string, otp: string) => this.record(order, await this.gateway.confirm3ds(id, otp), { chargeId: id });
    return { charge, confirm3ds, dropResponses: (n?: number) => this.gateway.dropResponses(n) };
  }

  private record(order: Order, r: ChargeResult, { req, key, chargeId }: { req?: ChargeRequest; key?: string; chargeId?: string }): ChargeResult {
    // declines have no charge id; the idempotency key identifies the attempt, so a replay is not counted twice
    const id = r.status !== "declined" ? `pay_${r.chargeId}` : chargeId ? `pay_${chargeId}` : `pay_demo_${(key ?? String(++this.seq)).slice(0, 8)}`;
    let rec = this.records.find((x) => x.payment.id === id);
    const now = new Date().toISOString();
    if (!rec) {
      const digits = req?.card.number ?? "";
      rec = {
        payment: {
          id,
          order_id: order.id,
          status: "failed",
          amount_minor: order.total_minor,
          amount_refunded_minor: 0,
          currency: "INR",
          decline_code: null,
          message: null,
          brand: r.status === "declined" ? "visa" : r.brand,
          last4: r.status === "declined" ? digits.slice(-4) : r.last4,
          created_at: now,
          customer_email: this.ownerOf.get(order.id)?.email,
        },
        order,
        customer: this.ownerOf.get(order.id) ?? USERS[1],
        events: [{ type: "payment.created", detail: "Demo payment from this browser tab", at: now }],
        refunds: [],
      };
      this.records.unshift(rec);
    }
    const p = rec.payment;
    if (r.status === "succeeded" && p.status !== "succeeded") {
      p.status = "succeeded";
      order.status = "paid";
      rec.events.push({ type: "payment.succeeded", detail: "Captured", at: now });
    } else if (r.status === "requires_action") {
      p.status = "requires_action";
      rec.events.push({ type: "payment.requires_action", detail: "Bank asked for 3-D Secure verification", at: now });
    } else if (r.status === "declined") {
      p.status = "failed";
      p.decline_code = r.code;
      p.message = r.message;
      rec.events.push({ type: "payment.failed", detail: `Declined: ${r.code}`, at: now });
    }
    return r;
  }

  async orders() {
    const u = this.needRole();
    return this.wait(this.orderList.filter((o) => this.ownerOf.get(o.id)?.id === u.id));
  }

  async order(id: string) {
    this.needRole();
    const o = this.orderList.find((x) => x.id === id);
    if (!o) throw new ApiError(404, "Order not found.");
    return this.wait({ ...o, payments: this.records.filter((r) => r.order.id === id).map((r) => r.payment) });
  }

  // ---------------------------------------------------------------- merchant

  private since(days: number) {
    const t = Date.now() - days * DAY;
    return this.records.filter((r) => Date.parse(r.payment.created_at) >= t);
  }

  async summary(days: number): Promise<Summary> {
    this.needRole("merchant");
    const rs = this.since(days).map((r) => r.payment);
    const cap = rs.filter((p) => CAPTURED.includes(p.status));
    const final = rs.filter((p) => p.status !== "requires_action" && p.status !== "canceled");
    const gross = cap.reduce((s, p) => s + p.amount_minor, 0);
    const refunded = cap.reduce((s, p) => s + p.amount_refunded_minor, 0);
    return this.wait({
      days,
      gross_minor: gross,
      refunded_minor: refunded,
      net_minor: gross - refunded,
      payments: cap.length,
      attempts: final.length,
      success_rate: final.length ? cap.length / final.length : null,
      avg_ticket_minor: cap.length ? Math.round(gross / cap.length) : 0,
      blocked_by_fraud_rule: rs.filter((p) => p.decline_code === "velocity_blocked").length,
    });
  }

  async timeseries(days: number): Promise<DayPoint[]> {
    this.needRole("merchant");
    const ist = (t: number) => new Date(t + 5.5 * 3600_000).toISOString().slice(0, 10); // Indian days, like the backend
    const out = new Map<string, DayPoint>();
    for (let i = days - 1; i >= 0; i--) {
      const d = ist(Date.now() - i * DAY);
      out.set(d, { date: d, succeeded: 0, failed: 0, captured_minor: 0 });
    }
    for (const { payment: p } of this.records) {
      const b = out.get(ist(Date.parse(p.created_at)));
      if (!b) continue;
      if (CAPTURED.includes(p.status)) {
        b.succeeded++;
        b.captured_minor += p.amount_minor;
      } else if (p.status === "failed") b.failed++;
    }
    return this.wait([...out.values()]);
  }

  async declines(days: number): Promise<DeclineCount[]> {
    this.needRole("merchant");
    const counts = new Map<string, number>();
    for (const { payment: p } of this.since(days)) if (p.status === "failed") counts.set(p.decline_code ?? "unknown", (counts.get(p.decline_code ?? "unknown") ?? 0) + 1);
    return this.wait([...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count));
  }

  async payments(q: PaymentQuery): Promise<PaymentPage> {
    this.needRole("merchant");
    const term = q.q?.trim().toLowerCase();
    const all = this.records
      .map((r) => r.payment)
      .filter((p) => !term || p.id === term || p.order_id === term || p.last4 === term || (p.customer_email ?? "").includes(term))
      .filter((p) => !q.status || p.status === q.status)
      .filter((p) => !q.brand || p.brand === q.brand);
    const limit = q.limit ?? 25;
    const offset = q.offset ?? 0;
    return this.wait({ total: all.length, limit, offset, items: all.slice(offset, offset + limit) });
  }

  async payment(id: string): Promise<PaymentDetail> {
    this.needRole("merchant");
    const r = this.records.find((x) => x.payment.id === id);
    if (!r) throw new ApiError(404, "Payment not found.");
    return this.wait({ ...r.payment, customer: r.customer, order: r.order, events: [...r.events], refunds: [...r.refunds], webhooks: [] });
  }

  private readonly refundKeys = new Set<string>();

  async refund(id: string, amountMinor: number | undefined, reason: string, key: string) {
    this.needRole("merchant");
    if (this.refundKeys.has(key)) return; // same key: already done
    const r = this.records.find((x) => x.payment.id === id);
    if (!r) throw new ApiError(404, "Payment not found.");
    const p = r.payment;
    if (p.status !== "succeeded" && p.status !== "partially_refunded") throw new ApiError(409, `A ${p.status} payment cannot be refunded.`);
    const left = p.amount_minor - p.amount_refunded_minor;
    const amount = amountMinor ?? left;
    if (amount <= 0 || amount > left) throw new ApiError(409, `Only ${left} paise can still be refunded.`);
    this.refundKeys.add(key);
    p.amount_refunded_minor += amount;
    p.status = p.amount_refunded_minor === p.amount_minor ? "refunded" : "partially_refunded";
    if (p.status === "refunded") r.order.status = "refunded";
    const at = new Date().toISOString();
    r.refunds.push({ id: `re_demo${++this.seq}`, amount_minor: amount, reason, created_at: at });
    r.events.push({ type: "refund.created", detail: `${formatAmount(amount)} refunded${reason ? `: ${reason}` : ""}`, at });
    await this.wait(undefined);
  }

  async webhooks(): Promise<WebhookOverview> {
    this.needRole("merchant");
    return this.wait({ endpoint: null, counts: {}, deliveries: [] }); // webhooks need a server to send them
  }

  async retryDelivery() {
    throw new ApiError(409, "Webhooks need the backend.");
  }

  // ---------------------------------------------------------------- simulated history

  private simulateHistory() {
    const rand = rng(7);
    const shoppers = Array.from({ length: 6 }, (_, i) => ({ id: 100 + i, email: `demo-customer-${i + 1}@example.com`, name: `Demo customer ${i + 1}`, role: "customer" as const }));
    const cards: [string, string, number][] = [["visa", "4242", 70], ["mastercard", "4444", 12], ["amex", "0005", 5]];
    const declines: [string, number][] = [["card_declined", 6], ["insufficient_funds", 5], ["authentication_failed", 1]];
    const pick = <T,>(xs: [T, ...unknown[]][], w: number[]) => {
      let x = rand() * w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < xs.length; i++) if ((x -= w[i]) <= 0) return xs[i];
      return xs[xs.length - 1];
    };
    const now = Date.now();
    for (let day = 13; day >= 0; day--) {
      const n = 6 + Math.floor(rand() * 7);
      for (let k = 0; k < n; k++) {
        const t = now - day * DAY - Math.floor(rand() * 10 * 3600_000);
        if (t > now) continue;
        const shopper = shoppers[Math.floor(rand() * shoppers.length)];
        const items = [...DEMO_PRODUCTS]
          .sort(() => rand() - 0.5)
          .slice(0, 1 + Math.floor(rand() * 3))
          .map((p) => ({ product_id: p.id, name: p.name, unit_price_minor: p.price_minor, quantity: 1 + Math.floor(rand() * 2) }));
        const total = items.reduce((s, i) => s + i.unit_price_minor * i.quantity, 0);
        const at = new Date(t).toISOString();
        const declined = rand() < 0.12;
        const [brand, last4] = pick(cards, cards.map((c) => c[2])) as unknown as [string, string];
        const code = declined ? (pick(declines, declines.map((d) => d[1]))[0] as string) : null;
        const order: Order = { id: `ord_sim${++this.seq}`, status: declined ? "pending" : "paid", total_minor: total, currency: "INR", created_at: at, items };
        this.records.unshift({
          payment: {
            id: `pay_sim${this.seq}`,
            order_id: order.id,
            status: declined ? "failed" : "succeeded",
            amount_minor: total,
            amount_refunded_minor: 0,
            currency: "INR",
            decline_code: code,
            message: null,
            brand: declined ? "visa" : brand,
            last4: declined ? "0002" : last4,
            created_at: at,
            customer_email: shopper.email,
          },
          order,
          customer: shopper,
          events: [
            { type: "payment.created", detail: "Simulated demo payment", at },
            declined ? { type: "payment.failed", detail: `Declined by issuer: ${code}`, at } : { type: "payment.succeeded", detail: "Authorised and captured", at },
          ],
          refunds: [],
        });
      }
    }
    this.records.sort((a, b) => Date.parse(b.payment.created_at) - Date.parse(a.payment.created_at));
  }
}
