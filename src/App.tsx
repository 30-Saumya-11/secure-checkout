import { useCallback, useMemo, useState } from "react";
import { CheckoutForm } from "./components/CheckoutForm";
import { HelpAssistant } from "./components/HelpAssistant";
import { MockGateway, TEST_CARDS, formatAmount } from "./lib/gateway";

const AMOUNT = 249900; // ₹2,499.00 in paise

export default function App() {
  const gateway = useMemo(() => new MockGateway(), []);
  const [lastDecline, setLastDecline] = useState<string | undefined>();
  const onFailure = useCallback((code: string | undefined) => setLastDecline(code), []);

  return (
    <main className="page">
      <h1>Checkout</h1>
      <section aria-labelledby="order" className="card">
        <h2 id="order">Order summary</h2>
        <p>Campus hoodie (M) &middot; 1 item</p>
        <p className="total">
          Total <strong>{formatAmount(AMOUNT)}</strong>
        </p>
      </section>
      <CheckoutForm gateway={gateway} amountMinor={AMOUNT} onFailure={onFailure} />
      <HelpAssistant lastDecline={lastDecline} />
      <details className="card">
        <summary>Demo test cards (no real payments)</summary>
        <ul>
          <li>Success: {TEST_CARDS.success}</li>
          <li>Declined: {TEST_CARDS.declined}</li>
          <li>Insufficient funds: {TEST_CARDS.insufficientFunds}</li>
          <li>Bank verification (code 123456): {TEST_CARDS.requires3ds}</li>
        </ul>
        <p>Any future expiry date and any 3-digit code work.</p>
        <p className="row">
          <button type="button" className="secondary" onClick={() => gateway.dropResponses(1)}>
            Simulate a lost response on the next payment
          </button>
        </p>
      </details>
    </main>
  );
}
