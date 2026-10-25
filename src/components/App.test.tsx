import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import App from "../App";
import { TEST_CARDS } from "../lib/gateway";

describe("checkout + help assistant together", () => {
  it("after a decline, a vague question is answered for THIS payment, with its source", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("Name on card"), "Saumya Goswami");
    await user.type(screen.getByLabelText("Card number"), TEST_CARDS.insufficientFunds);
    await user.type(screen.getByLabelText("Expiry date"), "1229");
    await user.type(screen.getByLabelText("Security code"), "123");
    await user.click(screen.getByRole("button", { name: /^pay ₹/i }));
    await screen.findByText("Your card has insufficient funds.", {}, { timeout: 3000 });

    await user.type(screen.getByLabelText("Ask about your payment"), "why did it fail");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/not have enough balance/)).toBeInTheDocument();
    expect(screen.getByText(/From: Payment failed: insufficient funds/)).toBeInTheDocument();
  });

  it("an out-of-scope question gets an honest 'I could not find this'", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText("Ask about your payment"), "what is the weather today");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/could not find this/)).toBeInTheDocument();
  });

  it("the whole page has no accessibility violations", async () => {
    const { container } = render(<App />);
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
