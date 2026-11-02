// What the page says about a booking's payment. "Paid" only when PayPal said COMPLETED (status
// captured / refunded); pending, failed and mismatched captures say so instead. Pure, so it is unit-tested.

const money = (m) => (m ? `${m.currency_code} ${m.value}` : "");

/** @returns {{ testid: string, text: string } | null} */
export function paymentLine(b) {
  if (!b.capture) return null;
  const amount = money(b.capture.amount ?? b.mandate?.amount);
  switch (b.status) {
    case "captured":
    case "partially_refunded":
    case "refunded":
      return { testid: "paid", text: `Paid ${amount} to ${b.guide.name} (capture ${b.capture.id}).` };
    case "capture_pending":
      return { testid: "payment-pending", text: `Payment pending: ${amount} to ${b.guide.name} is not complete yet (PayPal status ${b.capture.status ?? "PENDING"}).` };
    case "capture_failed":
      return { testid: "payment-failed", text: `Payment failed: PayPal reported ${b.capture.status ?? "a failure"}; nothing was paid to ${b.guide.name}.` };
    default:
      return { testid: "payment-review", text: `Payment needs review: PayPal's reply did not match the approved mandate (status ${b.capture.status ?? "unknown"}).` };
  }
}

/**
 * What the Demo controls show in each PayPal mode. The controls (simulate a cyclone warning, Start over)
 * show in fake and sandbox mode. The guide's balance only with the fake: it is the fake's own bookkeeping,
 * and in sandbox mode the guide's balance lives in PayPal's sandbox dashboard. Live mode never runs.
 * @returns {{ controls: boolean, guideBalance: boolean }}
 */
export function demoView(mode) {
  return { controls: mode === "fake" || mode === "sandbox", guideBalance: mode === "fake" };
}

/** The line under the Demo controls after "Simulate a cyclone warning (demo)". */
export function demoMessage(r) {
  if (!r || r.error) return r?.error ?? "That didn't work.";
  if (r.simulated) {
    return r.posted
      ? `Simulated cyclone warning (demo) posted for ${r.date}, for your booking only. Ambree will react; no money moves by itself.`
      : `A simulated warning was already posted for this booking (${r.date}).`;
  }
  return `Demo warning raised for ${r.bookings_warned} booking${r.bookings_warned === 1 ? "" : "s"}.`;
}
