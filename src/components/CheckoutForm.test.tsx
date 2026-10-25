import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { MockGateway, TEST_CARDS } from "../lib/gateway";
import { CheckoutForm } from "./CheckoutForm";

function setup(gateway = new MockGateway(20)) {
  const user = userEvent.setup();
  const utils = render(<CheckoutForm gateway={gateway} amountMinor={249900} retryDelayMs={5} />);
  const fill = async (number: string = TEST_CARDS.success, cvc = "123") => {
    await user.type(screen.getByLabelText("Name on card"), "Saumya Goswami");
    await user.type(screen.getByLabelText("Card number"), number);
    await user.type(screen.getByLabelText("Expiry date"), "1229");
    await user.type(screen.getByLabelText("Security code"), cvc);
  };
  const pay = () => screen.getByRole("button", { name: /^pay ₹/i });
  return { user, gateway, fill, pay, ...utils };
}

async function axeViolations(container: HTMLElement) {
  // color-contrast needs real layout, which jsdom does not do; it is checked in the browser with Lighthouse instead
  const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  return res.violations.map((v) => `${v.id}: ${v.help}`);
}

describe("CheckoutForm", () => {
  it("has no accessibility violations, empty or with errors showing", async () => {
    const { container, user, pay } = setup();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(pay());
    expect(await axeViolations(container)).toEqual([]);
  });

  it("every input has the right autocomplete token for browsers and password managers", () => {
    setup();
    expect(screen.getByLabelText("Card number")).toHaveAttribute("autocomplete", "cc-number");
    expect(screen.getByLabelText("Expiry date")).toHaveAttribute("autocomplete", "cc-exp");
    expect(screen.getByLabelText("Security code")).toHaveAttribute("autocomplete", "cc-csc");
    expect(screen.getByLabelText("Name on card")).toHaveAttribute("autocomplete", "cc-name");
  });

  it("formats the number as the user types and shows the card network", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Card number"), "4242424242424242");
    expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242");
    expect(screen.getByText("Visa")).toBeInTheDocument();
  });

  it("submitting an empty form lists the problems, links them to the fields and moves focus to the list", async () => {
    const { user, pay, gateway } = setup();
    await user.click(pay());
    const summary = screen.getByRole("group", { name: /fix 4 problems/i });
    expect(summary).toHaveFocus();
    const number = screen.getByLabelText("Card number");
    expect(number).toHaveAttribute("aria-invalid", "true");
    expect(number).toHaveAccessibleDescription("Enter your card number.");
    expect(gateway.charges).toHaveLength(0);
  });

  it("does not show errors while the user is still typing a field for the first time", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Card number"), "4242");
    expect(screen.queryByText(/incomplete/)).not.toBeInTheDocument();
  });

  it("a successful payment shows a receipt with only the last 4 digits", async () => {
    const { user, fill, pay, gateway } = setup();
    await fill();
    await user.click(pay());
    expect(await screen.findByRole("heading", { name: "Payment successful" })).toBeInTheDocument();
    expect(screen.getByText(/•••• 4242/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("4242 4242 4242 4242");
    expect(gateway.capturedCount).toBe(1);
  });

  it("double-clicking Pay charges the card once", async () => {
    const { user, fill, pay, gateway } = setup();
    await fill();
    await user.dblClick(pay());
    await screen.findByRole("heading", { name: "Payment successful" });
    expect(gateway.capturedCount).toBe(1);
  });

  it("a lost response is retried with the same key: one charge, and the customer sees success", async () => {
    const { user, fill, pay, gateway } = setup();
    gateway.dropResponses(1);
    await fill();
    await user.click(pay());
    await screen.findByRole("heading", { name: "Payment successful" });
    expect(gateway.capturedCount).toBe(1);
  });

  it("when retries run out, pressing Pay again is safe and still charges once", async () => {
    const { user, fill, pay, gateway } = setup();
    gateway.dropResponses(3); // more than the automatic retries
    await fill();
    await user.click(pay());
    expect(await screen.findByText(/will not be charged twice/)).toBeInTheDocument();
    expect(gateway.capturedCount).toBe(1); // the first request did go through
    await user.type(screen.getByLabelText("Security code"), "123"); // the code is cleared after a failure
    await user.click(pay());
    await screen.findByRole("heading", { name: "Payment successful" });
    expect(gateway.capturedCount).toBe(1);
  });

  it("a decline is announced in the live status region and clears the security code", async () => {
    const { user, fill, pay } = setup();
    await fill(TEST_CARDS.declined);
    await user.click(pay());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your card was declined."));
    // cleared by an effect right after the failure is shown, so wait for it rather than assume it already ran
    await waitFor(() => expect(screen.getByLabelText("Security code")).toHaveValue(""));
  });

  it("3-D Secure: focus moves into the dialog and the right code completes the payment", async () => {
    const { user, fill, pay, gateway } = setup();
    await fill(TEST_CARDS.requires3ds);
    await user.click(pay());
    const dialog = await screen.findByRole("dialog", { name: "Verify your payment" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("One-time code")).toHaveFocus();
    await user.type(screen.getByLabelText("One-time code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByRole("heading", { name: "Payment successful" });
    expect(gateway.capturedCount).toBe(1);
  });

  it("3-D Secure: Escape cancels and nothing is charged", async () => {
    const { user, fill, pay, gateway } = setup();
    await fill(TEST_CARDS.requires3ds);
    await user.click(pay());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(await screen.findByText(/cancelled/)).toBeInTheDocument();
    expect(gateway.capturedCount).toBe(0);
  });

  it("the whole form works with the keyboard alone", async () => {
    const { user, gateway } = setup();
    await user.tab();
    expect(screen.getByLabelText("Name on card")).toHaveFocus();
    await user.keyboard("Saumya Goswami");
    await user.tab();
    await user.keyboard(TEST_CARDS.success);
    await user.tab();
    await user.keyboard("1229");
    await user.tab();
    await user.keyboard("123");
    await user.tab();
    expect(screen.getByRole("button", { name: /^pay ₹/i })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Payment successful" });
    expect(gateway.capturedCount).toBe(1);
  });
});
