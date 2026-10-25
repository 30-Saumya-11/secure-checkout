// Card rules used by the checkout form. Pure functions, no React, so they are easy to test.
// Brand detection uses common IIN (issuer identification number) ranges; it is not an exhaustive BIN table.

export type Brand = "visa" | "mastercard" | "amex" | "rupay" | "unknown";

interface BrandRule {
  brand: Exclude<Brand, "unknown">;
  ranges: [number, number][]; // inclusive prefix ranges; both ends have the same number of digits
  lengths: number[];
  cvcLength: number;
  groups: number[]; // how the number is spaced when displayed
}

const RULES: BrandRule[] = [
  { brand: "amex", ranges: [[34, 34], [37, 37]], lengths: [15], cvcLength: 4, groups: [4, 6, 5] },
  { brand: "mastercard", ranges: [[51, 55], [2221, 2720]], lengths: [16], cvcLength: 3, groups: [4, 4, 4, 4] },
  // RuPay: published ranges commonly cited for RuPay debit/credit cards
  { brand: "rupay", ranges: [[508500, 508999], [606985, 607984], [608001, 608500], [652150, 653149]], lengths: [16], cvcLength: 3, groups: [4, 4, 4, 4] },
  { brand: "visa", ranges: [[4, 4]], lengths: [13, 16, 19], cvcLength: 3, groups: [4, 4, 4, 4, 3] },
];

export const digitsOnly = (s: string): string => s.replace(/\D/g, "");

function ruleFor(digits: string): BrandRule | undefined {
  return RULES.find((r) =>
    r.ranges.some(([lo, hi]) => {
      const n = String(lo).length;
      if (digits.length < n) return false;
      const prefix = Number(digits.slice(0, n));
      return prefix >= lo && prefix <= hi;
    }),
  );
}

export function detectBrand(input: string): Brand {
  return ruleFor(digitsOnly(input))?.brand ?? "unknown";
}

export function cvcLength(brand: Brand): number {
  return RULES.find((r) => r.brand === brand)?.cvcLength ?? 3;
}

/** Luhn (mod 10) checksum: catches single-digit typos and most swapped neighbouring digits. */
export function luhnValid(input: string): boolean {
  const d = digitsOnly(input);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Spaces the number the way it is printed on the card: Amex 4-6-5, others 4-4-4-4. Caps the length. */
export function formatCardNumber(input: string): string {
  const rule = ruleFor(digitsOnly(input));
  const max = rule ? Math.max(...rule.lengths) : 19;
  const d = digitsOnly(input).slice(0, max);
  const groups = rule?.groups ?? [4, 4, 4, 4, 3];
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= d.length) break;
    out.push(d.slice(i, i + g));
    i += g;
  }
  return out.join(" ");
}

/** "1229" or "12/29" -> "12/29" while typing. */
export function formatExpiry(input: string): string {
  const d = digitsOnly(input).slice(0, 4);
  return d.length <= 2 ? d : `${d.slice(0, 2)}/${d.slice(2)}`;
}

/** Only the last 4 digits ever leave the form for display or logs. */
export function maskCardNumber(input: string): string {
  const d = digitsOnly(input);
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : "••••";
}

export interface CardInput {
  name: string;
  number: string;
  expiry: string; // MM/YY
  cvc: string;
}

export type CardErrors = Partial<Record<keyof CardInput, string>>;

export function validateCard(card: CardInput, now: Date = new Date()): CardErrors {
  const errors: CardErrors = {};
  const digits = digitsOnly(card.number);
  const rule = ruleFor(digits);

  if (card.name.trim().length < 2) errors.name = "Enter the name shown on the card.";

  if (!digits) errors.number = "Enter your card number.";
  else if (!rule) errors.number = "This card type is not supported. Use Visa, Mastercard, RuPay or American Express.";
  else if (!rule.lengths.includes(digits.length)) errors.number = "The card number is incomplete.";
  else if (!luhnValid(digits)) errors.number = "This card number is not valid. Check for typing mistakes.";

  const m = /^(\d{2})\/(\d{2})$/.exec(card.expiry.trim());
  if (!m) errors.expiry = "Enter the expiry date as MM/YY.";
  else {
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    if (month < 1 || month > 12) errors.expiry = "The expiry month must be between 01 and 12.";
    else {
      // a card is valid until the END of its expiry month
      const endOfMonth = new Date(year, month, 1);
      if (endOfMonth <= now) errors.expiry = "This card has expired.";
      else if (year > now.getFullYear() + 20) errors.expiry = "Check the expiry year.";
    }
  }

  const need = cvcLength(rule?.brand ?? "unknown");
  if (!new RegExp(`^\\d{${need}}$`).test(card.cvc)) errors.cvc = `Enter the ${need}-digit security code.`;

  return errors;
}
