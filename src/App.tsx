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
    <>
      <header className="topbar">
        <div className="topbar-in">
          <span className="logo" aria-hidden="true">◆</span>
          <span className="shop">Campus Store</span>
          <span className="secure">
            <span aria-hidden="true">🔒</span> Secure checkout
          </span>
        </div>
      </header>
      <main className="page">
        <h1>Checkout</h1>
        <div className="layout">
          <div className="main-col">
            <section aria-labelledby="pay-h" className="card">
              <h2 id="pay-h">Pay by card</h2>
              <ul className="brands" aria-label="Accepted cards">
                <li>VISA</li>
                <li>Mastercard</li>
                <li>RuPay</li>
                <li>AMEX</li>
              </ul>
              <CheckoutForm gateway={gateway} amountMinor={AMOUNT} onFailure={onFailure} />
              <p className="trust">
                Protected by 3-D Secure. Your card number is masked and your security code is never stored. Retrying is safe:
                you are never charged twice.
              </p>
            </section>
          </div>
          <aside className="side-col">
            <section aria-labelledby="order" className="card">
              <h2 id="order">Order summary</h2>
              <div className="item">
                <span className="thumb" aria-hidden="true">👕</span>
                <div>
                  <p className="item-name">Campus hoodie</p>
                  <p className="muted">Size M · Qty 1</p>
                </div>
                <span>{formatAmount(AMOUNT)}</span>
              </div>
              <p className="total">
                <span>Total</span> <strong>{formatAmount(AMOUNT)}</strong>
              </p>
            </section>
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
              <button type="button" className="secondary" onClick={() => gateway.dropResponses(1)}>
                Simulate a lost response on the next payment
              </button>
            </details>
          </aside>
        </div>
      </main>
    </>
  );
}
