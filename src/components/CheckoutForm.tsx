// Accessible card form:
// - every field has a visible label, the right autocomplete token and a numeric keyboard on phones
// - errors are linked to their field (aria-describedby), marked aria-invalid, and summarised in a focusable list
// - payment progress is announced through a polite live region; the Pay button cannot double-submit
// - the full card number and CVC exist only in this component's state and are cleared after a decline

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useCheckout } from "../hooks/useCheckout";
import { cvcLength, detectBrand, formatCardNumber, formatExpiry, validateCard, type CardErrors, type CardInput } from "../lib/card";
import { formatAmount, type MockGateway } from "../lib/gateway";
import { ChallengeDialog } from "./ChallengeDialog";

const BRAND_LABEL: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", rupay: "RuPay", unknown: "" };
const FIELD_LABEL: Record<keyof CardInput, string> = { name: "Name on card", number: "Card number", expiry: "Expiry date", cvc: "Security code" };

interface Props {
  gateway: MockGateway;
  amountMinor: number;
  retryDelayMs?: number;
  onFailure?: (code: string | undefined) => void; // lets the help assistant know why the payment failed
}

export function CheckoutForm({ gateway, amountMinor, retryDelayMs, onFailure }: Props) {
  const [card, setCard] = useState<CardInput>({ name: "", number: "", expiry: "", cvc: "" });
  const [errors, setErrors] = useState<CardErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof CardInput, boolean>>>({});
  const summaryRef = useRef<HTMLDivElement>(null);
  const [focusSummary, setFocusSummary] = useState(0);
  const { state, submit, confirmChallenge, cancelChallenge } = useCheckout({ gateway, amountMinor, retryDelayMs });
  const uid = useId();
  const brand = detectBrand(card.number);
  const busy = state.phase === "processing" || state.phase === "retrying";

  const set = (field: keyof CardInput) => (e: ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value;
    if (field === "number") v = formatCardNumber(v);
    if (field === "expiry") v = formatExpiry(v);
    if (field === "cvc") v = v.replace(/\D/g, "").slice(0, cvcLength(brand));
    const next = { ...card, [field]: v };
    setCard(next);
    if (touched[field]) setErrors(validateCard(next)); // live re-check only after the user has left the field once
  };

  const blur = (field: keyof CardInput) => () => {
    setTouched((t) => ({ ...t, [field]: true }));
    setErrors(validateCard(card));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateCard(card);
    setErrors(found);
    setTouched({ name: true, number: true, expiry: true, cvc: true });
    if (Object.keys(found).length) {
      // the list only exists after the next render, so focus it in an effect, not here
      setFocusSummary((n) => n + 1);
      return;
    }
    await submit(card);
  };

  // screen-reader and keyboard users land on the list of problems after a failed submit
  useEffect(() => {
    if (focusSummary) summaryRef.current?.focus();
  }, [focusSummary]);

  // after a failed payment the security code is cleared, so it never lingers in memory longer than needed
  useEffect(() => {
    if (state.phase === "failed") {
      setCard((c) => (c.cvc ? { ...c, cvc: "" } : c));
      onFailure?.(state.code);
    }
  }, [state.phase, state.message, state.code, onFailure]);

  if (state.phase === "succeeded" && state.receipt) {
    return (
      <section aria-labelledby={`${uid}-done`} className="card">
        <h2 id={`${uid}-done`}>Payment successful</h2>
        <p>
          {formatAmount(state.receipt.amountMinor)} paid with {BRAND_LABEL[state.receipt.brand] || "card"} •••• {state.receipt.last4}.
        </p>
        <p className="muted">Reference: {state.receipt.chargeId}</p>
      </section>
    );
  }

  const shown = (f: keyof CardInput) => (touched[f] ? errors[f] : undefined);
  const errorList = (Object.keys(errors) as (keyof CardInput)[]).filter((f) => touched[f]);

  const field = (f: keyof CardInput, props: Record<string, unknown>) => {
    const err = shown(f);
    const id = `${uid}-${f}`;
    return (
      <div className="field">
        <label htmlFor={id}>{FIELD_LABEL[f]}</label>
        <input
          id={id}
          name={f}
          value={card[f]}
          onChange={set(f)}
          onBlur={blur(f)}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? `${id}-err` : undefined}
          disabled={busy}
          {...props}
        />
        {err && (
          <p id={`${id}-err`} className="error">
            {err}
          </p>
        )}
      </div>
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate className="card" aria-label="Card payment">
      {errorList.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} className="summary" role="group" aria-labelledby={`${uid}-sum`}>
          <h2 id={`${uid}-sum`}>Please fix {errorList.length === 1 ? "1 problem" : `${errorList.length} problems`}</h2>
          <ul>
            {errorList.map((f) => (
              <li key={f}>
                <a href={`#${uid}-${f}`}>{errors[f]}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {field("name", { autoComplete: "cc-name" })}
      <div className="field-with-brand">
        {field("number", { autoComplete: "cc-number", inputMode: "numeric", placeholder: "1234 5678 9012 3456" })}
        {BRAND_LABEL[brand] && <span className="brand" aria-hidden="true">{BRAND_LABEL[brand]}</span>}
      </div>
      <div className="row">
        {field("expiry", { autoComplete: "cc-exp", inputMode: "numeric", placeholder: "MM/YY" })}
        {field("cvc", { autoComplete: "cc-csc", inputMode: "numeric", placeholder: brand === "amex" ? "4 digits" : "3 digits" })}
      </div>

      <button type="submit" disabled={busy} aria-disabled={busy}>
        {busy ? "Processing…" : `Pay ${formatAmount(amountMinor)}`}
      </button>

      <p role="status" aria-live="polite" className={state.phase === "failed" ? "status error" : "status"}>
        {state.message}
      </p>

      {state.phase === "challenge" && <ChallengeDialog busy={busy} onConfirm={confirmChallenge} onCancel={cancelChallenge} />}
    </form>
  );
}
