// Simulated 3-D Secure step: the bank asks for a one-time code. Focus moves into the dialog, Escape cancels,
// and the error is announced to screen readers.

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

interface Props {
  busy: boolean;
  onConfirm: (otp: string) => void;
  onCancel: () => void;
}

export function ChallengeDialog({ busy, onConfirm, onCancel }: Props) {
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errId = useId();

  useEffect(() => input.current?.focus(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(otp)) {
      setError("Enter the 6-digit code sent by your bank.");
      return;
    }
    setError("");
    onConfirm(otp);
  };

  return (
    <div className="backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="dialog" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
        <h2 id={titleId}>Verify your payment</h2>
        <p>Your bank sent a one-time code to your phone. (Demo code: 123456)</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="otp">One-time code</label>
          <input
            id="otp"
            ref={input}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errId : undefined}
          />
          {error && (
            <p id={errId} className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button type="submit" disabled={busy}>
              Verify
            </button>
            <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
