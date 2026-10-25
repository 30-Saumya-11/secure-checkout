// Evaluation questions for the help assistant, phrased the way customers write (short, informal, no article words).
// article: the article that answers it, or null when the help centre does not cover it (the assistant should refuse).
// split: thresholds are chosen on "dev" only; results are reported on "test".

export interface EvalQuestion {
  q: string;
  article: string | null;
  split: "dev" | "test";
  lastDecline?: string;
}

export const QUESTIONS: EvalQuestion[] = [
  // dev
  { q: "why did my payment fail", article: "card-declined", split: "dev", lastDecline: "card_declined" },
  { q: "not enough balance in account", article: "insufficient-funds", split: "dev" },
  { q: "otp not coming", article: "otp-verification", split: "dev" },
  { q: "will i be charged twice if i click pay again", article: "double-charge", split: "dev" },
  { q: "when will i get my refund", article: "refunds", split: "dev" },
  { q: "do you save my cvv", article: "card-security", split: "dev" },
  { q: "can i use amex", article: "supported-cards", split: "dev" },
  { q: "what are your delivery charges", article: null, split: "dev" },
  { q: "how do i change my shipping address", article: null, split: "dev" },
  { q: "do you have size L in stock", article: null, split: "dev" },

  // test
  { q: "my bank rejected the payment what should i do", article: "card-declined", split: "test" },
  { q: "payment failed", article: "insufficient-funds", split: "test", lastDecline: "insufficient_funds" },
  { q: "entered wrong otp", article: "otp-verification", split: "test" },
  { q: "is it safe to share the code with your support team", article: "otp-verification", split: "test" },
  { q: "money got deducted twice", article: "double-charge", split: "test" },
  { q: "page froze while paying, should i retry", article: "double-charge", split: "test" },
  { q: "money cut from account but order failed", article: "refunds", split: "test" },
  { q: "how long does a refund take", article: "refunds", split: "test" },
  { q: "is my card information safe with you", article: "card-security", split: "test" },
  { q: "do you accept rupay debit cards", article: "supported-cards", split: "test" },
  { q: "my amex security code is 4 digits", article: "supported-cards", split: "test" },
  { q: "card number shows not valid", article: "card-details-errors", split: "test" },
  { q: "my card expired this month can i still use it", article: "card-details-errors", split: "test" },
  { q: "can i pay with a card from abroad", article: "international-cards", split: "test" },
  { q: "payment stuck on processing", article: "payment-pending", split: "test" },
  { q: "verification failed", article: "otp-verification", split: "test", lastDecline: "authentication_failed" },
  { q: "can i return the hoodie", article: null, split: "test" },
  { q: "do you ship to Nepal", article: null, split: "test" },
  { q: "is there a student discount", article: null, split: "test" },
  { q: "can i pay cash on delivery", article: null, split: "test" },
];
