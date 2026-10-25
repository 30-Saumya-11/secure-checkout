// Payment help assistant (RAG): answers from the help centre with the sources it used, or says it does not know.
// Answers are announced through a polite live region; the newest answer comes last, like a chat.

import { useId, useState, type FormEvent } from "react";
import { ask, type Generate, type Reply } from "../assistant/assistant";

interface Props {
  lastDecline?: string; // the reason the last payment failed, used to understand vague questions
  generate?: Generate; // optional LLM call through your own backend
}

export function HelpAssistant({ lastDecline, generate }: Props) {
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<{ q: string; reply: Reply }[]>([]);
  const [busy, setBusy] = useState(false);
  const uid = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    const reply = await ask(q, { lastDecline, generate });
    setLog((l) => [...l, { q, reply }]);
    setQuestion("");
    setBusy(false);
  };

  return (
    <section aria-labelledby={`${uid}-h`} className="card">
      <h2 id={`${uid}-h`}>Payment help</h2>
      <div aria-live="polite" className="chat">
        {log.map(({ q, reply }, i) => (
          <div key={i} className="turn">
            <p className="you">
              <strong>You:</strong> {q}
            </p>
            <p>
              <strong>Assistant:</strong> {reply.text}
            </p>
            {reply.sources.length > 0 && (
              <p className="muted source">From: {reply.sources.map((s) => `${s.title} › ${s.heading}`).join("; ")}</p>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="row" noValidate>
        <label htmlFor={`${uid}-q`} className="visually-hidden">
          Ask about your payment
        </label>
        <input
          id={`${uid}-q`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Will I be charged twice?"
          maxLength={300}
          autoComplete="off"
        />
        <button type="submit" disabled={busy} className="ask">
          Ask
        </button>
      </form>
    </section>
  );
}
