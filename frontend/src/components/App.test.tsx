import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import App from "../App";
import { DEMO_PASSWORD, DemoApi } from "../api/demoApi";
import { TEST_CARDS } from "../lib/gateway";

// the checkout page as a signed-in customer with a hoodie in the cart
async function checkout() {
  const api = new DemoApi(0, false);
  await api.login("customer@campus.store", DEMO_PASSWORD);
  return render(
    <MemoryRouter initialEntries={["/checkout"]}>
      <App api={api} initialCart={[{ productId: 1, quantity: 1 }]} retryDelayMs={5} />
    </MemoryRouter>,
  );
}

describe("checkout + help assistant together", () => {
  it("after a decline, a vague question is answered for THIS payment, with its source", async () => {
    const user = userEvent.setup();
    await checkout();
    await user.type(await screen.findByLabelText("Name on card"), "Saumya Goswami");
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
    await checkout();
    await user.type(await screen.findByLabelText("Ask about your payment"), "what is the weather today");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/could not find this/)).toBeInTheDocument();
  });

  it("the whole page has no accessibility violations", async () => {
    const { container } = await checkout();
    await screen.findByLabelText("Card number");
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
