// Evaluation helpers shared by the tests and `npm run eval:assistant`.

import { retrieve } from "./assistant";
import { QUESTIONS, type EvalQuestion } from "./questions";

export function rankOf(q: EvalQuestion, k = 5): number | null {
  const ids = [...new Set(retrieve(q.q, q.lastDecline, 4 * k).map((h) => h.chunk.articleId))].slice(0, k);
  const i = q.article ? ids.indexOf(q.article) : -1;
  return i >= 0 ? i + 1 : null;
}

/** Threshold that best separates covered from uncovered questions on the given split (ties: refuse less). */
export function chooseThreshold(split: "dev" | "test"): number {
  const qs = QUESTIONS.filter((q) => q.split === split);
  const tops = qs.map((q) => ({ q, top: retrieve(q.q, q.lastDecline, 1)[0]?.score ?? 0 }));
  let best = { t: 0, correct: -1 };
  for (let t = 0; t <= 15; t += 0.25) {
    const correct = tops.filter(({ q, top }) => (q.article === null) === top < t).length;
    if (correct > best.correct) best = { t, correct };
  }
  return best.t;
}

export function evaluate(split: "dev" | "test", threshold: number) {
  const qs = QUESTIONS.filter((q) => q.split === split);
  const covered = qs.filter((q) => q.article);
  const uncovered = qs.filter((q) => !q.article);
  const ranks = covered.map(rankOf);
  const top = (q: EvalQuestion) => retrieve(q.q, q.lastDecline, 1)[0]?.score ?? 0;
  return {
    split,
    covered: covered.length,
    uncovered: uncovered.length,
    recallAt1: ranks.filter((r) => r === 1).length / covered.length,
    recallAt3: ranks.filter((r) => r !== null && r <= 3).length / covered.length,
    mrr: ranks.reduce((s: number, r) => s + (r ? 1 / r : 0), 0) / covered.length,
    refusedUncovered: uncovered.filter((q) => top(q) < threshold).length,
    refusedCovered: covered.filter((q) => top(q) < threshold).length,
    misses: covered.filter((_, i) => ranks[i] !== 1).map((x) => x.q),
  };
}
