// Checkout state machine:  idle -> processing (-> retrying) -> challenge (3-D Secure) -> succeeded | failed
//
// Retry safety: one Idempotency-Key per payment attempt. After a network error the SAME key is reused, so if the
// first request actually charged the card, the retry returns that charge instead of creating a second one.
// A new key is used only for a genuinely new attempt (a decline, or different card details).

import { useCallback, useRef, useState } from "react";
import { digitsOnly, type CardInput } from "../lib/card";
import { IdempotencyConflict, MockGateway, NetworkError, newIdempotencyKey, type ChargeResult } from "../lib/gateway";

export type Phase = "idle" | "processing" | "retrying" | "challenge" | "succeeded" | "failed";

export interface CheckoutState {
  phase: Phase;
  message: string;
  code?: string; // why the last attempt failed: a decline code, "network" or "authentication_failed"
  receipt?: Extract<ChargeResult, { status: "succeeded" }>;
  chargeId?: string;
}

interface Options {
  gateway: MockGateway;
  amountMinor: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cardFingerprint = (c: CardInput) => `${digitsOnly(c.number)}|${c.expiry}`;

export function useCheckout({ gateway, amountMinor, maxRetries = 2, retryDelayMs = 800 }: Options) {
  const [state, setState] = useState<CheckoutState>({ phase: "idle", message: "" });
  const busy = useRef(false); // a ref, not state: blocks a double click before React re-renders
  const attempt = useRef<{ key: string; fp: string } | null>(null);

  const handleResult = useCallback((r: ChargeResult) => {
    if (r.status === "succeeded") {
      attempt.current = null;
      setState({ phase: "succeeded", message: "Payment successful.", receipt: r });
    } else if (r.status === "requires_action") {
      setState({ phase: "challenge", message: "Your bank needs to verify this payment.", chargeId: r.chargeId });
    } else {
      attempt.current = null; // a decline ends this attempt; trying again is a new payment
      setState({ phase: "failed", message: r.message, code: r.code });
    }
  }, []);

  const submit = useCallback(
    async (card: CardInput) => {
      if (busy.current) return;
      busy.current = true;
      const fp = cardFingerprint(card);
      if (!attempt.current || attempt.current.fp !== fp) attempt.current = { key: newIdempotencyKey(), fp };
      const key = attempt.current.key;
      const [mm, yy] = card.expiry.split("/");
      const request = {
        amountMinor,
        currency: "INR" as const,
        card: { number: digitsOnly(card.number), expMonth: Number(mm), expYear: 2000 + Number(yy), cvc: card.cvc, name: card.name.trim() },
      };
      setState({ phase: "processing", message: "Processing your payment…" });
      try {
        for (let tries = 0; ; tries++) {
          try {
            handleResult(await gateway.charge(request, key));
            return;
          } catch (e) {
            if (e instanceof NetworkError && tries < maxRetries) {
              setState({ phase: "retrying", message: "Connection problem. Retrying safely…" });
              await sleep(retryDelayMs * (tries + 1));
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        if (e instanceof IdempotencyConflict) {
          attempt.current = null;
          setState({ phase: "failed", message: "Something went wrong with this payment. Please try again." });
        } else {
          // keep the key: pressing Pay again re-sends the SAME attempt, which can never charge twice
          setState({ phase: "failed", message: "We could not confirm your payment. Pressing Pay again is safe: you will not be charged twice.", code: "network" });
        }
      } finally {
        busy.current = false;
      }
    },
    [amountMinor, gateway, handleResult, maxRetries, retryDelayMs],
  );

  const confirmChallenge = useCallback(
    async (otp: string) => {
      if (busy.current || !state.chargeId) return;
      busy.current = true;
      setState((s) => ({ ...s, phase: "processing", message: "Verifying…" }));
      try {
        handleResult(await gateway.confirm3ds(state.chargeId, otp));
      } catch {
        setState({ phase: "failed", message: "We could not verify the payment. Please try again." });
      } finally {
        busy.current = false;
      }
    },
    [gateway, handleResult, state.chargeId],
  );

  const cancelChallenge = useCallback(() => {
    attempt.current = null;
    setState({ phase: "failed", message: "Verification was cancelled. You have not been charged.", code: "authentication_failed" });
  }, []);

  return { state, submit, confirmChallenge, cancelChallenge };
}
