import { describe, expect, it } from "vitest";
import { IdempotencyConflict, MockGateway, NetworkError, TEST_CARDS, TEST_OTP, type ChargeRequest } from "./gateway";

const req = (number: string = TEST_CARDS.success, amountMinor = 249900): ChargeRequest => ({
  amountMinor,
  currency: "INR",
  card: { number, expMonth: 12, expYear: 2029, cvc: "123", name: "Test User" },
});

describe("MockGateway", () => {
  it("charges a valid card once", async () => {
    const g = new MockGateway(0);
    const r = await g.charge(req(), "k1");
    expect(r.status).toBe("succeeded");
    expect(g.capturedCount).toBe(1);
  });

  it("the same Idempotency-Key returns the same result and never charges twice", async () => {
    const g = new MockGateway(0);
    const a = await g.charge(req(), "k1");
    const b = await g.charge(req(), "k1");
    expect(b).toEqual(a);
    expect(g.capturedCount).toBe(1);
  });

  it("a different key is a different payment", async () => {
    const g = new MockGateway(0);
    await g.charge(req(), "k1");
    await g.charge(req(), "k2");
    expect(g.capturedCount).toBe(2);
  });

  it("reusing a key for a different payment is refused", async () => {
    const g = new MockGateway(0);
    await g.charge(req(), "k1");
    await expect(g.charge(req(TEST_CARDS.success, 100), "k1")).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  it("a lost response still charged the card; retrying with the same key does not charge again", async () => {
    const g = new MockGateway(0);
    g.dropResponses(1);
    await expect(g.charge(req(), "k1")).rejects.toBeInstanceOf(NetworkError);
    expect(g.capturedCount).toBe(1); // the money moved even though the client saw an error
    const retry = await g.charge(req(), "k1");
    expect(retry.status).toBe("succeeded");
    expect(g.capturedCount).toBe(1);
  });

  it("declines with a reason for the decline test cards", async () => {
    const g = new MockGateway(0);
    expect(await g.charge(req(TEST_CARDS.declined), "a")).toMatchObject({ status: "declined", code: "card_declined" });
    expect(await g.charge(req(TEST_CARDS.insufficientFunds), "b")).toMatchObject({ status: "declined", code: "insufficient_funds" });
    expect(g.capturedCount).toBe(0);
  });

  it("3-D Secure: charged only after the right code", async () => {
    const g = new MockGateway(0);
    const r = await g.charge(req(TEST_CARDS.requires3ds), "k");
    expect(r.status).toBe("requires_action");
    expect(g.capturedCount).toBe(0);
    if (r.status !== "requires_action") throw new Error();
    expect((await g.confirm3ds(r.chargeId, TEST_OTP)).status).toBe("succeeded");
    expect(g.capturedCount).toBe(1);
  });

  it("3-D Secure: a wrong code fails and cannot be retried into a charge", async () => {
    const g = new MockGateway(0);
    const r = await g.charge(req(TEST_CARDS.requires3ds), "k");
    if (r.status !== "requires_action") throw new Error();
    expect(await g.confirm3ds(r.chargeId, "000000")).toMatchObject({ code: "authentication_failed" });
    expect((await g.confirm3ds(r.chargeId, TEST_OTP)).status).toBe("declined");
    expect(g.capturedCount).toBe(0);
  });

  it("rejects non-integer or non-positive amounts (money is kept in paise)", async () => {
    const g = new MockGateway(0);
    expect(await g.charge(req(TEST_CARDS.success, 0), "a")).toMatchObject({ code: "invalid_request" });
    expect(await g.charge(req(TEST_CARDS.success, 10.5), "b")).toMatchObject({ code: "invalid_request" });
  });

  it("stores only a token, the brand and the last 4 digits, never the number or CVC", async () => {
    const g = new MockGateway(0);
    await g.charge(req(), "k");
    const stored = JSON.stringify(g.charges);
    expect(stored).not.toContain(TEST_CARDS.success);
    expect(stored).not.toContain('"cvc"');
    expect(g.charges[0]).toMatchObject({ last4: "4242", brand: "visa" });
  });
});
