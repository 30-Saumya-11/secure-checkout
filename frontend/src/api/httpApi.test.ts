// The real-backend client, with fetch replaced by a fake server: retries, tokens per attempt, error mapping.

import { afterEach, describe, expect, it, vi } from "vitest";
import { IdempotencyConflict, NetworkError } from "../lib/gateway";
import { ApiGateway, HttpApi } from "./httpApi";
import type { Order } from "./types";

const order: Order = { id: "ord_1", status: "pending", total_minor: 249900, currency: "INR", created_at: "", items: [] };
const req = { amountMinor: 249900, currency: "INR" as const, card: { number: "4242424242424242", expMonth: 12, expYear: 2029, cvc: "123", name: "S" } };
const payment = (status: string, extra = {}) => ({ id: "pay_1", order_id: "ord_1", status, amount_minor: 249900, brand: "visa", last4: "4242", decline_code: null, message: null, ...extra });

type Call = { url: string; body: unknown; headers: Record<string, string> };

function fakeServer(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> });
      const next = responses.shift();
      if (!next || next instanceof Error) throw next ?? new Error("no more responses");
      return next;
    }),
  );
  return calls;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("ApiGateway", () => {
  it("tokenises once per attempt, so a retry sends the same body with the same key", async () => {
    const calls = fakeServer([json(201, { token: "tok_a" }), new TypeError("offline"), json(201, payment("succeeded"))]);
    const g = new ApiGateway(new HttpApi("http://api"), order);
    await expect(g.charge(req, "key-1")).rejects.toBeInstanceOf(NetworkError);
    const r = await g.charge(req, "key-1");
    expect(r).toMatchObject({ status: "succeeded", chargeId: "pay_1", last4: "4242" });
    const pays = calls.filter((c) => c.url.endsWith("/api/payments"));
    expect(pays).toHaveLength(2);
    expect(pays[0].body).toEqual(pays[1].body);
    expect(pays.map((c) => c.headers["Idempotency-Key"])).toEqual(["key-1", "key-1"]);
    expect(calls.filter((c) => c.url.endsWith("/api/cards/tokens"))).toHaveLength(1);
  });

  it("a 5xx is treated as 'unknown outcome' (NetworkError), so the checkout retries with the same key", async () => {
    fakeServer([json(201, { token: "tok_a" }), json(503, { detail: "lost" })]);
    await expect(new ApiGateway(new HttpApi("http://api"), order).charge(req, "k")).rejects.toBeInstanceOf(NetworkError);
  });

  it("asks the server to lose the response only once when the demo tool is used", async () => {
    const calls = fakeServer([json(201, { token: "tok_a" }), json(503, {}), json(201, payment("succeeded"))]);
    const g = new ApiGateway(new HttpApi("http://api"), order);
    g.dropResponses(1);
    await expect(g.charge(req, "k")).rejects.toBeInstanceOf(NetworkError);
    await g.charge(req, "k");
    const pays = calls.filter((c) => c.url.endsWith("/api/payments"));
    expect(pays[0].headers["X-Simulate-Lost-Response"]).toBe("1");
    expect(pays[1].headers["X-Simulate-Lost-Response"]).toBeUndefined();
  });

  it("maps declines, 3-D Secure and key conflicts", async () => {
    fakeServer([
      json(201, { token: "t1" }),
      json(201, payment("failed", { decline_code: "insufficient_funds", message: "Your card has insufficient funds." })),
      json(201, { token: "t2" }),
      json(201, payment("requires_action")),
      json(201, { token: "t3" }),
      json(409, { detail: "used", code: "idempotency_conflict" }),
    ]);
    const g = new ApiGateway(new HttpApi("http://api"), order);
    expect(await g.charge(req, "a")).toEqual({ status: "declined", code: "insufficient_funds", message: "Your card has insufficient funds." });
    expect((await g.charge(req, "b")).status).toBe("requires_action");
    await expect(g.charge(req, "c")).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  it("an invalid card is shown as a decline, not a crash", async () => {
    fakeServer([json(422, { detail: "The card has expired.", code: "invalid_card" })]);
    expect(await new ApiGateway(new HttpApi("http://api"), order).charge(req, "k")).toMatchObject({ status: "declined", message: "The card has expired." });
  });
});

describe("HttpApi", () => {
  it("sends the session token and forgets it when the server says it expired", async () => {
    const calls = fakeServer([json(200, { token: "jwt-1", user: { id: 1, email: "a@b.c", name: "A", role: "customer" } }), json(401, { detail: "expired" }), json(200, [])]);
    const api = new HttpApi("http://api");
    await api.login("a@b.c", "pw");
    await expect(api.orders()).rejects.toThrow("expired");
    expect(calls[1].headers.Authorization).toBe("Bearer jwt-1");
    await api.products();
    expect(calls[2].headers.Authorization).toBeUndefined();
  });

  it("builds the payments query string without empty filters", async () => {
    const calls = fakeServer([json(200, { total: 0, limit: 20, offset: 0, items: [] })]);
    await new HttpApi("http://api").payments({ q: "4242", status: "", limit: 20 });
    expect(calls[0].url).toBe("http://api/api/merchant/payments?q=4242&limit=20");
  });
});
