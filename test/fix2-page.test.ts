// Round 2, #5: the page's payment line never says "Paid" unless PayPal said COMPLETED.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module, no types
import { paymentLine } from "../public/labels.js";

const base = { guide: { name: "Lantern Ridge Walks (demo)" }, mandate: { amount: { currency_code: "EUR", value: "30.00" } } };

describe("round 2 #5: payment line on the page", () => {
  it("pending, failed and review states never say Paid", () => {
    const pending = paymentLine({ ...base, status: "capture_pending", capture: { id: "C1", amount: null, status: "PENDING" } });
    expect(pending.text).toMatch(/^Payment pending/);
    expect(pending.testid).toBe("payment-pending");
    const failed = paymentLine({ ...base, status: "capture_failed", capture: { id: "C1", amount: null, status: "DECLINED" } });
    expect(failed.text).toMatch(/^Payment failed/);
    const review = paymentLine({ ...base, status: "needs_review", capture: { id: "C1", amount: null, status: "COMPLETED" } });
    expect(review.text).toMatch(/needs review/);
    for (const l of [pending, failed, review]) expect(l.text).not.toMatch(/\bPaid\b/);
  });

  it("a completed capture says Paid", () => {
    const paid = paymentLine({ ...base, status: "captured", capture: { id: "C1", amount: { currency_code: "EUR", value: "30.00" }, status: "COMPLETED" } });
    expect(paid).toEqual({ testid: "paid", text: "Paid EUR 30.00 to Lantern Ridge Walks (demo) (capture C1)." });
    expect(paymentLine({ ...base, status: "order_created", capture: null })).toBeNull();
  });
});
