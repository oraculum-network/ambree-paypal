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
