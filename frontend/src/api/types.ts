// Shapes returned by the backend (backend/app). The demo API returns the same shapes.

import type { PaymentGateway } from "../lib/gateway";

export type Role = "customer" | "merchant";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface Product {
  id: number;
  name: string;
  description: string;
  emoji: string;
  price_minor: number;
  active: boolean;
}

export interface OrderItem {
  product_id: number;
  name: string;
  unit_price_minor: number;
  quantity: number;
}

export type PaymentStatus = "requires_action" | "succeeded" | "partially_refunded" | "refunded" | "failed" | "canceled";

export interface Payment {
  id: string;
  order_id: string;
  status: PaymentStatus;
  amount_minor: number;
  amount_refunded_minor: number;
  currency: string;
  decline_code: string | null;
  message: string | null;
  brand: string;
  last4: string;
  created_at: string;
  customer_email?: string;
}

export interface Order {
  id: string;
  status: "pending" | "paid" | "refunded";
  total_minor: number;
  currency: string;
  created_at: string;
  items: OrderItem[];
  payments?: Payment[];
}

export interface Summary {
  days: number;
  gross_minor: number;
  refunded_minor: number;
  net_minor: number;
  payments: number;
  attempts: number;
  success_rate: number | null;
  avg_ticket_minor: number;
  blocked_by_fraud_rule: number;
}

export interface DayPoint {
  date: string;
  succeeded: number;
  failed: number;
  captured_minor: number;
}

export interface DeclineCount {
  code: string;
  count: number;
}

export interface PaymentPage {
  total: number;
  limit: number;
  offset: number;
  items: Payment[];
}

export interface Delivery {
  id: number;
  event_id: string;
  event_type: string;
  payment_id: string | null;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface PaymentDetail extends Payment {
  customer: { id: number; email: string; name: string };
  order: Order;
  events: { type: string; detail: string; at: string }[];
  refunds: { id: string; amount_minor: number; reason: string; created_at: string }[];
  webhooks: Delivery[];
}

export interface WebhookOverview {
  endpoint: { id: number; url: string; active: boolean; secret_hint: string } | null;
  counts: Record<string, number>;
  deliveries: Delivery[];
}

export interface PaymentQuery {
  q?: string;
  status?: string;
  brand?: string;
  limit?: number;
  offset?: number;
}

export interface CartLine {
  productId: number;
  quantity: number;
}

/** Everything the pages need. HttpApi talks to the backend; DemoApi runs in the browser for the static demo. */
export interface StoreApi {
  readonly mode: "api" | "demo";
  login(email: string, password: string): Promise<User>;
  logout(): void;
  currentUser(): Promise<User | null>;
  products(): Promise<Product[]>;
  createOrder(lines: CartLine[], idempotencyKey: string): Promise<Order>;
  gatewayFor(order: Order): PaymentGateway;
  orders(): Promise<Order[]>;
  order(id: string): Promise<Order>;
  summary(days: number): Promise<Summary>;
  timeseries(days: number): Promise<DayPoint[]>;
  declines(days: number): Promise<DeclineCount[]>;
  payments(q: PaymentQuery): Promise<PaymentPage>;
  payment(id: string): Promise<PaymentDetail>;
  refund(paymentId: string, amountMinor: number | undefined, reason: string, idempotencyKey: string): Promise<void>;
  webhooks(): Promise<WebhookOverview>;
  retryDelivery(id: number): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
