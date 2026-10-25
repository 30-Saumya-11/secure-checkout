// Help-centre articles for the payment assistant. Written for this demo store (not any real bank's or network's policy).
// Each article is split into sections; a section is the unit the assistant retrieves and cites.

export interface Article {
  id: string;
  title: string;
  sections: { heading: string; text: string }[];
}

export const ARTICLES: Article[] = [
  {
    id: "card-declined",
    title: "Why was my card declined?",
    sections: [
      { heading: "Common reasons", text: "Your bank declined the payment. Common reasons are a blocked card, a card not enabled for online payments, a daily spending limit, or a suspected fraud check by your bank. The store cannot see the exact reason your bank used." },
      { heading: "What to do", text: "Call the number on the back of your card or open your banking app and check that online payments are enabled. Then try again, or use a different card. Declined payments are not charged." },
    ],
  },
  {
    id: "insufficient-funds",
    title: "Payment failed: insufficient funds",
    sections: [
      { heading: "What it means", text: "Your bank says the account or credit limit does not have enough balance for this amount. Nothing was charged." },
      { heading: "What to do", text: "Add money to the account, use a card with a higher available limit, or pay with a different card." },
    ],
  },
  {
    id: "otp-verification",
    title: "Bank verification and one-time codes (3-D Secure)",
    sections: [
      { heading: "Why my bank asks for a code", text: "For many online card payments your bank asks you to confirm the payment with a one-time code sent to your registered mobile number. This step, called 3-D Secure, protects you if someone else has your card details." },
      { heading: "Wrong or expired code", text: "If the code is wrong or has expired, the payment fails and you are not charged. Start the payment again to receive a new code. Never share the code with anyone, including people who say they work for the store." },
      { heading: "Did not receive the code", text: "Check that your mobile number is up to date with your bank and that you have network coverage. Codes can take up to a minute to arrive." },
    ],
  },
  {
    id: "double-charge",
    title: "Will I be charged twice if I retry or the page freezes?",
    sections: [
      { heading: "Retrying is safe", text: "Every payment attempt carries a unique key. If the connection drops and you press Pay again, the payment server recognises the same attempt and returns the original result instead of charging again. Double-clicking Pay is also ignored." },
      { heading: "If you see two debits", text: "One of them is usually a temporary hold (authorisation) that your bank releases within 5 to 7 working days. If both remain after that, contact support with the payment reference." },
    ],
  },
  {
    id: "refunds",
    title: "Refunds and failed payment reversals",
    sections: [
      { heading: "Refund timeline", text: "Approved refunds go back to the original card. Most banks show the refund within 5 to 7 working days, some take up to 10." },
      { heading: "Money debited but order failed", text: "If money left your account but the order failed, it is reversed automatically, usually within 5 to 7 working days. You do not need to request it." },
    ],
  },
  {
    id: "card-security",
    title: "How is my card information protected?",
    sections: [
      { heading: "What we store", text: "The store never stores your full card number or your security code (CVV). The payment server keeps only a token, the card network and the last 4 digits, so receipts can show which card was used." },
      { heading: "Staying safe", text: "We will never ask for your full card number, CVV or one-time code by phone, email or chat." },
    ],
  },
  {
    id: "supported-cards",
    title: "Which cards can I use?",
    sections: [
      { heading: "Accepted cards", text: "We accept Visa, Mastercard, RuPay and American Express credit and debit cards. Discover and Diners Club are not accepted." },
      { heading: "Security code length", text: "American Express cards use a 4-digit security code printed on the front. Other cards use a 3-digit code on the back." },
    ],
  },
  {
    id: "card-details-errors",
    title: "My card number or expiry date shows an error",
    sections: [
      { heading: "Card number not valid", text: "The card number failed a checksum, which usually means a mistyped or swapped digit. Check the number on your card and type it again." },
      { heading: "Card expired", text: "A card works until the last day of its expiry month. If it has expired, use the new card your bank sent you." },
    ],
  },
  {
    id: "international-cards",
    title: "Can I pay with a card issued outside India?",
    sections: [
      { heading: "International cards", text: "Cards issued outside India are accepted if your bank allows international online payments. Your bank may charge a currency conversion fee." },
    ],
  },
  {
    id: "payment-pending",
    title: "My payment is stuck or pending",
    sections: [
      { heading: "What pending means", text: "The payment server has not yet confirmed the result, often because of a slow network. Do not close the page while it says Processing." },
      { heading: "Checking the result", text: "If the page shows that we could not confirm your payment, pressing Pay again is safe and will not charge twice. You will see the final result within a few seconds." },
    ],
  },
];
