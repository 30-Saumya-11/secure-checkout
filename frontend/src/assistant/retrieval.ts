// Retrieval for the payment help assistant (the "R" in RAG), written out so every step is explainable:
//   1. split articles into sections (chunks) that keep their source for citations
//   2. BM25 ranking over title + heading + text (exact words such as "OTP", "declined", "refund")
//   3. synonym expansion so customers' words match the articles' words ("otp" -> "code", "money cut" -> "debited")
//   4. context-aware queries: the decline code from the last payment attempt is added to the question
//   5. refuse when even the best section is a weak match, instead of guessing

import { ARTICLES } from "./articles";

export interface Chunk {
  id: string; // "otp-verification#2"
  articleId: string;
  title: string;
  heading: string;
  text: string;
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

const STOP = new Set(
  "a an the and or of to in on for is are be it at by with as from this that if so any can i my me do does did what when how who why which will would should you your we our there was were has have had not no am get got".split(" "),
);

// customer words -> words used in the articles
const SYNONYMS: Record<string, string[]> = {
  otp: ["code", "verification"],
  pin: ["code"],
  cvv: ["security", "code"],
  cvc: ["security", "code"],
  twice: ["double", "two", "debits"],
  double: ["twice", "two"],
  deducted: ["debited"],
  cut: ["debited"],
  refund: ["refunds"],
  stuck: ["pending"],
  safe: ["protected", "security"],
  failed: ["declined", "failed"],
  rejected: ["declined"],
  balance: ["insufficient", "funds"],
  money: ["funds", "debited"],
  abroad: ["international", "outside"],
  foreign: ["international", "outside"],
  amex: ["american", "express"],
};

const stem = (w: string) => {
  for (const suf of ["ing", "ed", "es", "s"]) if (w.length > suf.length + 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  return w;
};

export function tokens(text: string, expand = false): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w));
  const out = expand ? words.flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]) : words;
  return out.map(stem);
}

export function buildChunks(): Chunk[] {
  return ARTICLES.flatMap((a) => a.sections.map((s, i) => ({ id: `${a.id}#${i + 1}`, articleId: a.id, title: a.title, heading: s.heading, text: s.text })));
}

export class Bm25Index {
  private readonly docs: string[][];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(
    readonly chunks: Chunk[],
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {
    // title and heading are short but say what the section is about, so they are counted twice
    this.docs = chunks.map((c) => tokens(`${c.title} ${c.title} ${c.heading} ${c.heading} ${c.text}`));
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / this.docs.length;
  }

  private idf(t: string): number {
    const n = this.docs.length;
    const f = this.df.get(t) ?? 0;
    return Math.log(1 + (n - f + 0.5) / (f + 0.5));
  }

  search(query: string, k = 3): Hit[] {
    const q = [...new Set(tokens(query, true))];
    const scored = this.docs.map((d, i) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      const norm = this.k1 * (1 - this.b + (this.b * d.length) / this.avgLen);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (f) score += (this.idf(t) * f * (this.k1 + 1)) / (f + norm);
      }
      return { chunk: this.chunks[i], score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// words added to the question when the customer has just seen this decline (context-aware retrieval)
export const DECLINE_CONTEXT: Record<string, string> = {
  card_declined: "card declined bank",
  insufficient_funds: "insufficient funds balance",
  authentication_failed: "verification code wrong",
  network: "pending confirm pay again twice",
  velocity_blocked: "card declined bank try different card",
};

/** Below this BM25 score the best section is too weak to answer from: the assistant refuses. Chosen on the dev questions. */
export const MIN_SCORE = 2.25; // = chooseThreshold("dev"); a test keeps the two in sync
