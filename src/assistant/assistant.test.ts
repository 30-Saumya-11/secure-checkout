import { describe, expect, it } from "vitest";
import { ask, buildPrompt, FALLBACK, retrieve } from "./assistant";
import { chooseThreshold, evaluate } from "./evaluate";
import { MIN_SCORE } from "./retrieval";

describe("help assistant: retrieval quality (held-out test questions)", () => {
  it("MIN_SCORE is the threshold chosen on the dev split", () => {
    expect(MIN_SCORE).toBe(chooseThreshold("dev"));
  });

  it("finds the right article and refuses uncovered questions", () => {
    const r = evaluate("test", MIN_SCORE);
    console.log("assistant eval (test split):", JSON.stringify({ ...r, misses: r.misses }, null, 1));
    // floors, so a change that makes retrieval worse fails CI
    expect(r.recallAt3).toBeGreaterThanOrEqual(0.9);
    expect(r.refusedCovered).toBeLessThanOrEqual(1);
  });
});

describe("help assistant: answers", () => {
  it("answers from the help centre and cites its source", async () => {
    const r = await ask("will i be charged twice if i press pay again");
    expect(r.refused).toBe(false);
    expect(r.sources[0].articleId).toBe("double-charge");
    expect(r.text).toMatch(/same attempt|original result|ignored/);
  });

  it("uses the decline code from the last payment to understand a vague question", async () => {
    const vague = "why did it fail";
    expect((await ask(vague, { lastDecline: "insufficient_funds" })).sources[0].articleId).toBe("insufficient-funds");
    expect((await ask(vague, { lastDecline: "authentication_failed" })).sources[0].articleId).toBe("otp-verification");
  });

  it("refuses questions the help centre does not cover, and points to a human", async () => {
    const r = await ask("what is the weather in Dehradun");
    expect(r.refused).toBe(true);
    expect(r.text).toBe(FALLBACK);
  });

  it("LLM answers are used only when they cite the sources they were given", async () => {
    const good = await ask("when will i get my refund", { generate: async () => '{"answer": "Within 5 to 7 working days.", "sources": [1]}' });
    expect(good.mode).toBe("llm");
    expect(good.sources).toHaveLength(1);

    const madeUp = await ask("when will i get my refund", { generate: async () => '{"answer": "Within 1 hour.", "sources": [9]}' });
    expect(madeUp.mode).toBe("extractive");
    expect(madeUp.text).not.toContain("1 hour");

    const noCitation = await ask("when will i get my refund", { generate: async () => '{"answer": "Soon."}' });
    expect(noCitation.mode).toBe("extractive");

    const broken = await ask("when will i get my refund", { generate: async () => { throw new Error("timeout"); } });
    expect(broken.mode).toBe("extractive");
  });

  it("the LLM prompt contains only the retrieved sources and forbids asking for card secrets", () => {
    const p = buildPrompt("refund?", retrieve("when will i get my refund"));
    expect(p).toMatch(/\[1\] Refunds/);
    expect(p).toMatch(/Never ask for a card number, CVV or one-time code/);
  });
});
