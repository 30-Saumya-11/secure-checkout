// The help assistant: retrieve the best help sections, then answer ONLY from them, with citations.
//
// Generation has two modes:
// - extractive (default): the sentences that best match the question, quoted from the retrieved sections
// - llm (optional): a language model writes the answer from numbered sources and must cite them; if it cites a source
//   it was not given (or none), its answer is rejected and the extractive answer is used. The model is called through
//   YOUR backend: an API key must never be shipped in frontend code.

import { ARTICLES } from "./articles";
import { Bm25Index, buildChunks, DECLINE_CONTEXT, MIN_SCORE, tokens, type Hit } from "./retrieval";

export interface Source {
  articleId: string;
  title: string;
  heading: string;
}

export interface Reply {
  text: string;
  sources: Source[];
  refused: boolean;
  mode: "extractive" | "llm" | "refused";
}

export type Generate = (prompt: string) => Promise<string>; // e.g. a fetch to your own /api/assist endpoint

export const FALLBACK =
  "I could not find this in the payment help centre. Please contact support with your payment reference, and never share your card number, CVV or one-time code.";

const index = new Bm25Index(buildChunks());

export function retrieve(question: string, lastDecline?: string, k = 3): Hit[] {
  const extra = lastDecline ? DECLINE_CONTEXT[lastDecline] ?? "" : "";
  return index.search(`${question} ${extra}`.trim(), k);
}

const sourceOf = (h: Hit): Source => ({ articleId: h.chunk.articleId, title: h.chunk.title, heading: h.chunk.heading });

function extractive(question: string, hits: Hit[]): Reply {
  const q = new Set(tokens(question, true));
  const sentences = hits.flatMap((h, rank) =>
    h.chunk.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => ({ s, h, score: tokens(s).filter((t) => q.has(t)).length - rank * 0.5 })),
  );
  sentences.sort((a, b) => b.score - a.score);
  const picked = sentences.filter((x) => x.score > 0).slice(0, 2);
  const chosen = picked.length ? picked : [{ s: hits[0].chunk.text, h: hits[0], score: 0 }];
  // keep the reading order of the article for the chosen sentences
  const text = chosen.map((x) => x.s).join(" ");
  const sources = [...new Map(chosen.map((x) => [x.h.chunk.id, sourceOf(x.h)])).values()];
  return { text, sources, refused: false, mode: "extractive" };
}

export function buildPrompt(question: string, hits: Hit[]): string {
  const numbered = hits.map((h, i) => `[${i + 1}] ${h.chunk.title} > ${h.chunk.heading}: ${h.chunk.text}`).join("\n");
  return [
    "You are a payment support assistant. Answer ONLY from the numbered sources. Max 3 sentences.",
    'Reply as JSON: {"answer": "...", "sources": [numbers]}. If the sources do not answer the question, say so.',
    "Never ask for a card number, CVV or one-time code.",
    `Sources:\n${numbered}`,
    `Question: ${question}`,
  ].join("\n\n");
}

export async function ask(question: string, opts: { lastDecline?: string; generate?: Generate } = {}): Promise<Reply> {
  const q = question.trim().slice(0, 300);
  const hits = retrieve(q, opts.lastDecline);
  if (!hits.length || hits[0].score < MIN_SCORE) return { text: FALLBACK, sources: [], refused: true, mode: "refused" };

  if (opts.generate) {
    try {
      const raw = await opts.generate(buildPrompt(q, hits));
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      const nums: number[] = (json.sources ?? []).map(Number);
      const answer = String(json.answer ?? "").trim();
      const valid = answer && nums.length && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= hits.length);
      if (valid) return { text: answer, sources: nums.map((n) => sourceOf(hits[n - 1])), refused: false, mode: "llm" };
    } catch {
      // fall through to the grounded extractive answer
    }
  }
  return extractive(q, hits);
}

export const articleTitle = (id: string) => ARTICLES.find((a) => a.id === id)?.title ?? id;
