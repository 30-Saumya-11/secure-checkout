// Talks to the FastAPI backend. The session token is kept in localStorage so a refresh keeps you signed in
// (trade-off: readable by any script on the page; an httpOnly cookie would be safer, see the README).

import { IdempotencyConflict, NetworkError, type ChargeRequest, type ChargeResult, type PaymentGateway } from "../lib/gateway";
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

const TOKEN_KEY = "store.token";

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export class HttpApi implements StoreApi {
  readonly mode = "api" as const;
  private token: string | null = readToken();

  constructor(private readonly base: string) {}

  /** fetch + JSON + errors. A failed connection or a 5xx becomes NetworkError: the request may or may not have run. */
  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new NetworkError();
    }
    if (r.status >= 500) throw new NetworkError();
    const data = r.status === 204 ? undefined : await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401 && this.token) this.logout(); // expired session
      const detail = typeof data?.detail === "string" ? data.detail : "The request was not valid.";
      throw new ApiError(r.status, detail, data?.code);
    }
    return data as T;
  }

  async login(email: string, password: string): Promise<User> {
    const r = await this.request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password });
    this.token = r.token;
    try {
      localStorage.setItem(TOKEN_KEY, r.token);
    } catch {
      /* private mode: stay signed in for this tab only */
    }
    return r.user;
  }

  logout() {
    this.token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing stored */
    }
  }

  async currentUser() {
    if (!this.token) return null;
    try {
      return await this.request<User>("GET", "/api/auth/me");
    } catch {
      return null;
    }
  }

  products = () => this.request<Product[]>("GET", "/api/products");
  createOrder = (lines: CartLine[], key: string) =>
    this.request<Order>("POST", "/api/orders", { items: lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })) }, { "Idempotency-Key": key });
  orders = () => this.request<Order[]>("GET", "/api/orders");
  order = (id: string) => this.request<Order>("GET", `/api/orders/${encodeURIComponent(id)}`);
  gatewayFor = (order: Order) => new ApiGateway(this, order);

  summary = (days: number) => this.request<Summary>("GET", `/api/merchant/summary?days=${days}`);
  timeseries = (days: number) => this.request<DayPoint[]>("GET", `/api/merchant/timeseries?days=${days}`);
  declines = (days: number) => this.request<DeclineCount[]>("GET", `/api/merchant/declines?days=${days}`);
  payments = (q: PaymentQuery) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return this.request<PaymentPage>("GET", `/api/merchant/payments?${qs}`);
  };
  payment = (id: string) => this.request<PaymentDetail>("GET", `/api/merchant/payments/${encodeURIComponent(id)}`);
  refund = async (id: string, amountMinor: number | undefined, reason: string, key: string) => {
    await this.request("POST", `/api/merchant/payments/${encodeURIComponent(id)}/refunds`, { amount_minor: amountMinor ?? null, reason }, { "Idempotency-Key": key });
  };
  webhooks = () => this.request<WebhookOverview>("GET", "/api/merchant/webhooks");
  retryDelivery = async (id: number) => {
    await this.request("POST", `/api/merchant/webhooks/deliveries/${id}/retry`);
  };
}

/** The checkout's gateway when a backend is configured: tokenise the card, then pay the order with the key. */
export class ApiGateway implements PaymentGateway {
  // one card token per payment attempt, so a retry sends exactly the same body (a new token would be a conflict)
  private readonly tokens = new Map<string, string>();
  private loseNext = 0;

  constructor(
    private readonly api: HttpApi,
    private readonly order: Order,
  ) {}

  dropResponses(n = 1) {
    this.loseNext = n;
  }

  async charge(req: ChargeRequest, key: string): Promise<ChargeResult> {
    let token = this.tokens.get(key);
    if (!token) {
      try {
        const t = await this.api.request<{ token: string }>("POST", "/api/cards/tokens", {
          number: req.card.number,
          exp_month: req.card.expMonth,
          exp_year: req.card.expYear,
          cvc: req.card.cvc,
          name: req.card.name,
        });
        token = t.token;
        this.tokens.set(key, token);
      } catch (e) {
        if (e instanceof ApiError) return { status: "declined", code: "invalid_request", message: e.message };
        throw e;
      }
    }
    const lose: Record<string, string> = this.loseNext > 0 ? (this.loseNext--, { "X-Simulate-Lost-Response": "1" }) : {};
    try {
      const p = await this.api.request<Payment>("POST", "/api/payments", { order_id: this.order.id, card_token: token }, { "Idempotency-Key": key, ...lose });
      return toResult(p);
    } catch (e) {
      if (e instanceof ApiError && e.code === "idempotency_conflict") throw new IdempotencyConflict();
      if (e instanceof ApiError) return { status: "declined", code: "invalid_request", message: e.message };
      throw e;
    }
  }

  async confirm3ds(chargeId: string, otp: string): Promise<ChargeResult> {
    try {
      const p = await this.api.request<Payment>("POST", `/api/payments/${encodeURIComponent(chargeId)}/confirm`, { otp }, { "Idempotency-Key": crypto.randomUUID() });
      return toResult(p);
    } catch (e) {
      if (e instanceof ApiError) return { status: "declined", code: "invalid_request", message: e.message };
      throw e;
    }
  }
}

function toResult(p: Payment): ChargeResult {
  const brand = p.brand as Extract<ChargeResult, { status: "succeeded" }>["brand"];
  if (p.status === "succeeded") return { status: "succeeded", chargeId: p.id, brand, last4: p.last4, amountMinor: p.amount_minor };
  if (p.status === "requires_action") return { status: "requires_action", chargeId: p.id, brand, last4: p.last4, amountMinor: p.amount_minor };
  const code = (p.decline_code ?? "card_declined") as Extract<ChargeResult, { status: "declined" }>["code"];
  return { status: "declined", code, message: p.message ?? "Your card was declined." };
}
