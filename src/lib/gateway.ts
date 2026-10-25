// A mock payment gateway that behaves like real ones in the ways that matter for the UI:
// - every charge request carries an Idempotency-Key; repeating it returns the first result instead of charging again
// - some test cards decline, need 3-D Secure, or fail; the network can drop a response AFTER the charge happened
// - the gateway keeps only a token, brand and last 4 digits; the full number and the CVC are never stored
// Demo only: no real payment network is contacted.

import { detectBrand, digitsOnly, type Brand } from "./card";

export interface ChargeRequest {
  amountMinor: number; // amount in the smallest unit (paise), so no floating-point money
  currency: "INR";
  card: { number: string; expMonth: number; expYear: number; cvc: string; name: string };
}

export type ChargeResult =
  | { status: "succeeded"; chargeId: string; brand: Brand; last4: string; amountMinor: number }
  | { status: "requires_action"; chargeId: string; brand: Brand; last4: string; amountMinor: number }
  | { status: "declined"; code: DeclineCode; message: string };

export type DeclineCode = "card_declined" | "insufficient_funds" | "authentication_failed" | "invalid_request";

export class NetworkError extends Error {
  constructor() {
    super("Network error: no response from the payment server");
  }
}

export class IdempotencyConflict extends Error {
  constructor() {
    super("This Idempotency-Key was already used for a different payment");
  }
}

// Test cards (Luhn-valid). Any other valid card succeeds.
export const TEST_CARDS = {
  success: "4242424242424242",
  declined: "4000000000000002",
  insufficientFunds: "4000000000009995",
  requires3ds: "4000000000003220",
  mastercard: "5555555555554444",
  amex: "378282246310005",
} as const;

export const TEST_OTP = "123456";

interface StoredCharge {
  id: string;
  token: string; // what a real gateway would return instead of the card number
  brand: Brand;
  last4: string;
  amountMinor: number;
  status: "succeeded" | "requires_action" | "failed";
}

const fingerprint = (r: ChargeRequest) => JSON.stringify([r.amountMinor, r.currency, digitsOnly(r.card.number).slice(-4), r.card.expMonth, r.card.expYear]);

export class MockGateway {
  private readonly idempotency = new Map<string, { fp: string; result: ChargeResult }>();
  readonly charges: StoredCharge[] = [];
  private dropNextResponses = 0;
  private failNextRequests = 0;
  private seq = 0;

  constructor(private readonly latencyMs = 400) {}

  /** The charge happens, but the response is lost on the way back (the classic double-charge trap). */
  dropResponses(n = 1) {
    this.dropNextResponses = n;
  }

  /** The request never reaches the gateway. */
  failRequests(n = 1) {
    this.failNextRequests = n;
  }

  /** Successful (money-moving) charges: what the customer would see on their statement. */
  get capturedCount() {
    return this.charges.filter((c) => c.status === "succeeded").length;
  }

  private wait() {
    return new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async charge(req: ChargeRequest, idempotencyKey: string): Promise<ChargeResult> {
    await this.wait();
    if (this.failNextRequests > 0) {
      this.failNextRequests--;
      throw new NetworkError();
    }
    if (!idempotencyKey) return { status: "declined", code: "invalid_request", message: "Missing Idempotency-Key." };

    const fp = fingerprint(req);
    const seen = this.idempotency.get(idempotencyKey);
    if (seen) {
      if (seen.fp !== fp) throw new IdempotencyConflict();
      return this.respond(seen.result);
    }

    const result = this.process(req);
    this.idempotency.set(idempotencyKey, { fp, result });
    return this.respond(result);
  }

  async confirm3ds(chargeId: string, otp: string): Promise<ChargeResult> {
    await this.wait();
    const c = this.charges.find((x) => x.id === chargeId);
    if (!c || c.status !== "requires_action") return { status: "declined", code: "invalid_request", message: "Nothing to confirm." };
    if (otp !== TEST_OTP) {
      c.status = "failed";
      return { status: "declined", code: "authentication_failed", message: "The verification code was incorrect." };
    }
    c.status = "succeeded";
    return { status: "succeeded", chargeId: c.id, brand: c.brand, last4: c.last4, amountMinor: c.amountMinor };
  }

  private respond(result: ChargeResult): ChargeResult {
    if (this.dropNextResponses > 0) {
      this.dropNextResponses--;
      throw new NetworkError();
    }
    return result;
  }

  private process(req: ChargeRequest): ChargeResult {
    const digits = digitsOnly(req.card.number);
    if (req.amountMinor <= 0 || !Number.isInteger(req.amountMinor)) {
      return { status: "declined", code: "invalid_request", message: "Invalid amount." };
    }
    if (digits === TEST_CARDS.declined) return { status: "declined", code: "card_declined", message: "Your card was declined." };
    if (digits === TEST_CARDS.insufficientFunds) return { status: "declined", code: "insufficient_funds", message: "Your card has insufficient funds." };

    const brand = detectBrand(digits);
    const id = `ch_${++this.seq}`;
    const needs3ds = digits === TEST_CARDS.requires3ds;
    // the CVC is checked and then discarded; only a token, brand and last 4 digits are kept
    this.charges.push({ id, token: `tok_${this.seq}`, brand, last4: digits.slice(-4), amountMinor: req.amountMinor, status: needs3ds ? "requires_action" : "succeeded" });
    return { status: needs3ds ? "requires_action" : "succeeded", chargeId: id, brand, last4: digits.slice(-4), amountMinor: req.amountMinor };
  }
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `key_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function formatAmount(amountMinor: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(amountMinor / 100);
}
