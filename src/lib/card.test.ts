import { describe, expect, it } from "vitest";
import { cvcLength, detectBrand, formatCardNumber, formatExpiry, luhnValid, maskCardNumber, validateCard } from "./card";
import { TEST_CARDS } from "./gateway";

/** Appends the Luhn check digit, so tests can build valid numbers for any prefix. */
function withCheckDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) if (luhnValid(partial + d)) return partial + d;
  throw new Error("unreachable");
}

const NOW = new Date(2026, 9, 25); // 25 Oct 2026
const valid = { name: "Saumya Goswami", number: "4242 4242 4242 4242", expiry: "12/29", cvc: "123" };

describe("Luhn checksum", () => {
  it("accepts every test card", () => {
    for (const n of Object.values(TEST_CARDS)) expect(luhnValid(n), n).toBe(true);
  });
  it("rejects a single mistyped digit and a swap of neighbouring digits", () => {
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("2442424242424242")).toBe(false);
  });
  it("ignores spaces and rejects numbers that are too short", () => {
    expect(luhnValid("4242 4242 4242 4242")).toBe(true);
    expect(luhnValid("0")).toBe(false);
  });
});

describe("card network detection", () => {
  it.each([
    ["4111111111111111", "visa"],
    ["5555555555554444", "mastercard"],
    ["2223003122003222", "mastercard"],
    ["378282246310005", "amex"],
    ["341111111111111", "amex"],
    [withCheckDigit("508500000000000"), "rupay"],
    [withCheckDigit("652150000000000"), "rupay"],
    ["6011111111111117", "unknown"], // Discover is not accepted here
    ["", "unknown"],
  ])("%s -> %s", (n, brand) => expect(detectBrand(n)).toBe(brand));

  it("Mastercard's 2-series range ends at 2720", () => {
    expect(detectBrand("2720990000000000")).toBe("mastercard");
    expect(detectBrand("2721000000000000")).toBe("unknown");
  });

  it("Amex uses a 4-digit security code, others 3", () => {
    expect(cvcLength("amex")).toBe(4);
    expect(cvcLength("visa")).toBe(3);
  });
});

describe("formatting and masking", () => {
  it("spaces numbers the way they are printed", () => {
    expect(formatCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
  });
  it("drops letters and caps the length for the card network", () => {
    expect(formatCardNumber("4242-4242-abcd-4242-4242-9999")).toBe("4242 4242 4242 4242 999");
    expect(formatCardNumber("3782822463100059999")).toBe("3782 822463 10005");
  });
  it("formats expiry as MM/YY while typing", () => {
    expect(formatExpiry("1")).toBe("1");
    expect(formatExpiry("122")).toBe("12/2");
    expect(formatExpiry("12/29")).toBe("12/29");
  });
  it("only the last 4 digits are ever shown", () => {
    expect(maskCardNumber("4242 4242 4242 4242")).toBe("•••• 4242");
    expect(maskCardNumber("42")).toBe("••••");
  });
});

describe("validateCard", () => {
  it("accepts a valid card", () => expect(validateCard(valid, NOW)).toEqual({}));

  it("explains each problem in plain language", () => {
    const e = validateCard({ name: "", number: "4242 4242 4242 4241", expiry: "13/29", cvc: "12" }, NOW);
    expect(e.name).toMatch(/name/);
    expect(e.number).toMatch(/not valid/);
    expect(e.expiry).toMatch(/01 and 12/);
    expect(e.cvc).toMatch(/3-digit/);
  });

  it("flags incomplete and unsupported numbers separately", () => {
    expect(validateCard({ ...valid, number: "4242 4242" }, NOW).number).toMatch(/incomplete/);
    expect(validateCard({ ...valid, number: "6011111111111117" }, NOW).number).toMatch(/not supported/);
  });

  it("a card is valid until the end of its expiry month", () => {
    expect(validateCard({ ...valid, expiry: "10/26" }, NOW).expiry).toBeUndefined(); // still October 2026
    expect(validateCard({ ...valid, expiry: "09/26" }, NOW).expiry).toMatch(/expired/);
  });

  it("asks Amex for a 4-digit code", () => {
    expect(validateCard({ ...valid, number: "378282246310005", cvc: "123" }, NOW).cvc).toMatch(/4-digit/);
    expect(validateCard({ ...valid, number: "378282246310005", cvc: "1234" }, NOW).cvc).toBeUndefined();
  });
});
