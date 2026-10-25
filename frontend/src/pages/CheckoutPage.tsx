// Checkout: the server creates the order from the cart (prices from the database, one Idempotency-Key per cart so a
// refresh or a double render never creates two orders), then the accessible CheckoutForm pays it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Order } from "../api/types";
import { CheckoutForm } from "../components/CheckoutForm";
import { HelpAssistant } from "../components/HelpAssistant";
import { TEST_CARDS, formatAmount, newIdempotencyKey } from "../lib/gateway";
import { useApp } from "../state";
import { ErrorNote, Loading } from "./customer";

function orderKey(signature: string): string {
  const name = `checkout.key.${signature}`;
  try {
    const saved = sessionStorage.getItem(name);
    if (saved) return saved;
    const k = newIdempotencyKey();
    sessionStorage.setItem(name, k);
    return k;
  } catch {
    return `cart-${signature}`;
  }
}

export function CheckoutPage({ retryDelayMs }: { retryDelayMs?: number }) {
  const { api, cart, clearCart } = useApp();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [lastDecline, setLastDecline] = useState<string | undefined>();
  const [paid, setPaid] = useState(false);
  const signature = cart.map((l) => `${l.productId}x${l.quantity}`).join(",");

  useEffect(() => {
    if (!signature || order) return;
    let live = true;
    api.createOrder(cart, orderKey(signature)).then(
      (o) => live && setOrder(o),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // the order is created once per cart content; cart identity changes are covered by `signature`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, signature]);

  const gateway = useMemo(() => (order ? api.gatewayFor(order) : null), [api, order]);
  const onFailure = useCallback((code: string | undefined) => setLastDecline(code), []);
  const onSuccess = useCallback(() => {
    setPaid(true);
    clearCart(); // the order keeps the page on screen; the cart can go
    try {
      sessionStorage.removeItem(`checkout.key.${signature}`);
    } catch {
      /* nothing saved */
    }
  }, [clearCart, signature]);

  if (!order && !signature) {
    return (
      <div className="card empty">
        <p>Your cart is empty.</p>
        <Link to="/">Continue shopping</Link>
      </div>
    );
  }
  if (error) return <ErrorNote message={error} />;
  if (!order || !gateway) return <Loading what="Preparing your order" />;

  return (
    <>
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
            <CheckoutForm gateway={gateway} amountMinor={order.total_minor} onFailure={onFailure} onSuccess={onSuccess} retryDelayMs={retryDelayMs} />
            {paid && (
              <p className="center">
                <Link to={`/orders/${order.id}`}>View your receipt →</Link>
              </p>
            )}
            <p className="trust">
              Protected by 3-D Secure. Your card number is masked and your security code is never stored. Retrying is safe: you
              are never charged twice.
            </p>
          </section>
        </div>
        <aside className="side-col">
          <section aria-labelledby="order-h" className="card">
            <h2 id="order-h">Order summary</h2>
            <ul className="lines compact">
              {order.items.map((i) => (
                <li key={i.product_id} className="item">
                  <div>
                    <p className="item-name">{i.name}</p>
                    <p className="muted">Qty {i.quantity}</p>
                  </div>
                  <span>{formatAmount(i.unit_price_minor * i.quantity)}</span>
                </li>
              ))}
            </ul>
            <p className="total">
              <span>Total</span> <strong>{formatAmount(order.total_minor)}</strong>
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
    </>
  );
}
