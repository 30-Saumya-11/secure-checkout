// The store and merchant pages, driven like a user would, against the in-browser demo API.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { DEMO_PASSWORD, DemoApi } from "../api/demoApi";
import { TEST_CARDS } from "../lib/gateway";

async function open(path: string, { as, history = false }: { as?: "customer" | "merchant"; history?: boolean } = {}) {
  const api = new DemoApi(0, history);
  if (as) await api.login(`${as}@campus.store`, DEMO_PASSWORD);
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App api={api} initialCart={[]} retryDelayMs={5} />
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup(), ...utils };
}

async function payWith(user: ReturnType<typeof userEvent.setup>, card: string) {
  await user.type(await screen.findByLabelText("Name on card"), "Saumya Goswami");
  await user.type(screen.getByLabelText("Card number"), card);
  await user.type(screen.getByLabelText("Expiry date"), "1229");
  await user.type(screen.getByLabelText("Security code"), "123");
  await user.click(screen.getByRole("button", { name: /^pay ₹/i }));
}

beforeEach(() => localStorage.clear());

describe("customer", () => {
  it("adds products to the cart and changes quantities", async () => {
    const { user } = await open("/");
    await user.click(await screen.findByRole("button", { name: "Add Campus hoodie to cart" }));
    await user.click(screen.getByRole("button", { name: "Add Coffee mug to cart" }));
    expect(screen.getByRole("status")).toHaveTextContent("Coffee mug added to cart");
    await user.click(screen.getByRole("link", { name: /^Cart/ }));
    expect(await screen.findByText("₹2,798.00")).toBeInTheDocument(); // 2,499 + 299
    await user.click(screen.getByRole("button", { name: "One more Coffee mug" }));
    expect(screen.getByText("₹3,097.00")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "One less Campus hoodie" }));
    expect(screen.getByText("₹598.00", { selector: ".total strong" })).toBeInTheDocument();
  });

  it("checkout asks you to sign in first, then comes back to checkout", async () => {
    const { user } = await open("/");
    await user.click(await screen.findByRole("button", { name: "Add Campus hoodie to cart" }));
    await user.click(screen.getByRole("link", { name: /^Cart/ }));
    await user.click(await screen.findByRole("link", { name: "Sign in to check out" }));
    await user.click(await screen.findByRole("button", { name: "Shop as a customer" }));
    expect(await screen.findByRole("heading", { name: "Checkout" })).toBeInTheDocument();
  });

  it("pays, empties the cart and shows the order with a receipt", async () => {
    const { user } = await open("/", { as: "customer" });
    await user.click(await screen.findByRole("button", { name: "Add Laptop backpack to cart" }));
    await user.click(screen.getByRole("link", { name: /^Cart/ }));
    await user.click(await screen.findByRole("link", { name: "Checkout" }));
    await payWith(user, TEST_CARDS.success);
    expect(await screen.findByText("Payment successful", {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: /^Cart/ })).not.toHaveTextContent(/\d/)); // cart is empty
    await user.click(screen.getByRole("link", { name: "View your receipt →" }));
    expect(await screen.findByRole("heading", { name: "Receipt" })).toBeInTheDocument();
    expect(screen.getByText(/Paid with visa •••• 4242/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "← All orders" }));
    expect(await screen.findAllByText("Paid")).toHaveLength(1);
  });

  it("customers cannot open merchant pages", async () => {
    await open("/merchant", { as: "customer" });
    expect(await screen.findByRole("alert")).toHaveTextContent("merchant account");
  });

  it("signed-out visitors are sent to sign in", async () => {
    await open("/merchant/payments");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("merchant", () => {
  it("dashboard shows the key numbers, both charts and recent payments", async () => {
    const { container } = await open("/merchant", { as: "merchant", history: true });
    const kpis = await screen.findByLabelText("Key numbers");
    for (const k of ["Net revenue", "Success rate", "Average ticket", "Blocked by fraud rule"]) expect(within(kpis).getByText(k)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Revenue per day for the last 14 days/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Failed payments by reason" })).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThan(1);
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });

  it("switching the period reloads the numbers", async () => {
    const { user } = await open("/merchant", { as: "merchant", history: true });
    await screen.findByLabelText("Key numbers");
    await user.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(screen.getByRole("img", { name: /last 7 days/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("filters payments by status and searches by last 4 digits", async () => {
    const { user } = await open("/merchant/payments", { as: "merchant", history: true });
    await screen.findByText(/^\d+ payments?$/);
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await waitFor(() => expect(screen.getAllByText("Failed", { selector: ".pill" }).length).toBeGreaterThan(0));
    expect(screen.queryByText("Succeeded", { selector: ".pill" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "");
    await user.type(screen.getByLabelText("Search"), "4444");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      const cards = screen.getAllByText(/•••• /);
      expect(cards.every((c) => c.textContent?.includes("4444"))).toBe(true);
    });
  });

  it("refunds part of a payment, then refuses more than is left", async () => {
    const { user, api } = await open("/merchant/payments", { as: "merchant", history: true });
    const page = await api.payments({ status: "succeeded", limit: 1 });
    const p = page.items[0];
    await user.click(await screen.findByRole("link", { name: p.id }));
    await user.type(await screen.findByLabelText(/Amount in ₹/), "100");
    await user.click(screen.getByRole("button", { name: "Refund" }));
    expect(await screen.findByText("Refunded ₹100.00.")).toBeInTheDocument();
    expect(await screen.findByText("Partly refunded", { selector: ".page-head .pill" })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Amount in ₹/), String(p.amount_minor / 100));
    await user.click(screen.getByRole("button", { name: "Refund" }));
    expect(await screen.findByText(/At most ₹/)).toBeInTheDocument();
  });

  it("a payment made in this tab appears in the merchant's list", async () => {
    const api = new DemoApi(0, false);
    await api.login("customer@campus.store", DEMO_PASSWORD);
    const order = await api.createOrder([{ productId: 2, quantity: 1 }], "k1");
    const again = await api.createOrder([{ productId: 2, quantity: 1 }], "k1");
    expect(again.id).toBe(order.id); // same key, same order
    const g = api.gatewayFor(order);
    await g.charge({ amountMinor: order.total_minor, currency: "INR", card: { number: TEST_CARDS.success, expMonth: 12, expYear: 2029, cvc: "123", name: "S" } }, "pay-1");
    api.logout();
    await api.login("merchant@campus.store", DEMO_PASSWORD);
    const list = await api.payments({});
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ status: "succeeded", amount_minor: 34900, customer_email: "customer@campus.store" });
  });
});
