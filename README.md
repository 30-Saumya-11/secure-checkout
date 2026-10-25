# Secure Checkout

An accessible, retry-safe card checkout in **React + TypeScript**, with a **RAG payment-help assistant** that answers
customers' payment questions from a help centre, cites its sources, and uses the reason the last payment failed.

Demo only: the payment gateway is a mock that runs in the browser. No real card network is contacted; use the test
cards below.

```
card form ──► validation (Luhn, network, expiry, CVC) ──► useCheckout ──► MockGateway
   │                                                  Idempotency-Key per attempt
   │                                                  retry on network error with the SAME key
   │                                                  3-D Secure challenge ──► one-time code dialog
   ▼
decline code ──► Help assistant: BM25 retrieval over help articles (+ decline code as context)
                 ──► answer quoted from the best sections, with sources ── or "I could not find this"
```

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 56 tests: card rules, gateway, form, accessibility, assistant, assistant evaluation
npm run build      # type-check + production build
```

| Test card | Result |
|---|---|
| 4242 4242 4242 4242 | succeeds |
| 4000 0000 0000 0002 | declined |
| 4000 0000 0000 9995 | insufficient funds |
| 4000 0000 0000 3220 | bank verification, code 123456 |

Any future expiry and any 3-digit code (4 for Amex) work. "Simulate a lost response" makes the next payment succeed on
the server while the browser sees a network error, which is the situation that causes double charges in real shops.

## What it gets right

**Never charges twice.** Every payment attempt has one Idempotency-Key. If the response is lost, the hook retries with
the same key and the gateway returns the original result. If retries run out, pressing Pay again re-sends the same
attempt. A double click is blocked by a ref (state would update too late). A new key is created only for a genuinely
new attempt: after a decline, or when the card details change. Reusing a key for a different payment is refused.

**Card data.** Numbers are checked with the Luhn checksum and matched to Visa, Mastercard, RuPay or Amex by their IIN
ranges; the CVC length follows the network (4 for Amex). The gateway keeps only a token, the network and the last 4
digits; receipts show `•••• 4242`; the CVC is cleared after a failure. Amounts are integers in paise, never floats.

**Accessibility (WCAG 2.1 AA practices).**
- every input has a visible label and the right `autocomplete` (`cc-number`, `cc-exp`, `cc-csc`, `cc-name`)
- errors appear after the user leaves a field, are linked with `aria-describedby` and marked `aria-invalid`
- on submit with errors, focus moves to a summary whose items link to the fields
- progress and results are announced in a polite live region; the 3-D Secure dialog takes focus and closes on Escape
- the whole flow works with the keyboard alone; touch targets are at least 44 px; colour contrast is checked in the stylesheet
- `axe-core` runs in the tests on the empty form, the form with errors and the full page (colour contrast needs a real
  browser, so check it with Lighthouse)

**Payment help assistant (RAG).**
- 10 help articles, 21 sections; BM25 retrieval written out in `src/assistant/retrieval.ts`, with synonym expansion
  (customers say "OTP", articles say "code") and light stemming
- the last decline code is added to the question, so "why did it fail?" is answered for *this* payment
- if the best section scores below a threshold, it answers "I could not find this" instead of guessing
- answers are quoted from the retrieved sections, with sources; an optional LLM mode (through your own backend, never an
  API key in the browser) must cite the sources it was given, otherwise the quoted answer is used

## Assistant evaluation

30 questions written the way customers phrase them, split into **dev (10)** and **test (20)**. The refusal threshold
(2.25) was chosen on dev only; a test fails if the code and the dev-chosen value ever differ. Results on test:

| Metric (test split) | Value |
|---|---|
| Right article ranked first | 14 / 16 (88%) |
| Right article in the top 3 | 15 / 16 (94%) |
| MRR | 0.90 |
| Out-of-scope questions refused | 3 / 4 |
| In-scope questions wrongly refused | 0 / 16 |

Missed at rank 1: "my bank rejected the payment what should i do" and "is it safe to share the code with your
support team". CI fails if recall@3 drops below 90%.

Limits: the articles and questions were written by the same person and the test set is small (one question is about
6 points), so these numbers are optimistic. They show the method works and catch regressions; they are not a claim
about real customer traffic.

## Layout

| Path | What |
|---|---|
| `src/lib/card.ts` | Luhn, network detection, formatting, expiry/CVC rules |
| `src/lib/gateway.ts` | Mock gateway: idempotency, declines, 3-D Secure, lost responses, tokenisation |
| `src/hooks/useCheckout.ts` | Checkout state machine and retry logic |
| `src/components/` | Checkout form, 3-D Secure dialog, help assistant |
| `src/assistant/` | Articles, retrieval, answering, evaluation questions |

## Things to be ready to explain

- Why the retry must reuse the Idempotency-Key, and when a new key is created.
- Why the double-click guard is a ref and not state.
- How the Luhn checksum works and what it does not catch.
- What `aria-live`, `aria-describedby` and `autocomplete="cc-number"` do for real users.
- Why the assistant refuses below a threshold, and why the threshold is chosen on dev, not test.
- Why an LLM API key must never be in frontend code.

## Next steps

- A real backend (the gateway logic is written to move server-side unchanged) and a real payment provider's hosted
  fields, so card data never touches this app at all (PCI DSS scope).
- Pretrained embeddings for the assistant, and questions written by real users.
