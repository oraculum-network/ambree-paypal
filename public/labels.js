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
 * The card's line for a move the agent proposed. "withdrawn": the deposit was fully refunded before the
 * guide answered, so the move was closed (the guide's page no longer asks).
 * @returns {{ testid: string, text: string } | null}
 */
export function rescheduleLine(b) {
  const r = b.reschedule;
  if (!r) return null;
  if (r.status === "withdrawn") return { testid: "reschedule", text: `Reschedule to ${r.new_date}: withdrawn, because the deposit was refunded.` };
  return { testid: "reschedule", text: `Reschedule to ${r.new_date}: ${r.status}` };
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

const NOT_PAID = ["requested", "priced", "mandate_proposed", "mandate_approved", "order_created"];
/** Why a finished (or still processing) booking can't take the simulated warning; the server says the same. */
const CANNOT_SIMULATE = {
  declined: "the guide declined the request",
  capture_pending: "PayPal is still processing the payment",
  capture_failed: "the payment failed",
  needs_review: "the booking is held for review",
  partially_refunded: "part of the deposit was already refunded",
  refunded: "the deposit was already refunded",
};

/**
 * Whether "Simulate a cyclone warning (demo)" can be pressed, and the reason when it can't. On the hosted
 * sandbox it acts on the tab's newest booking, and only once that booking is paid (captured). Fake mode is
 * unchanged: any booking will do (it raises a demo-feed warning around all of them).
 * @returns {{ disabled: boolean, hint: string }}
 */
export function simulateControl(mode, bookings) {
  const newest = (bookings ?? []).at(-1);
  if (mode !== "sandbox") return { disabled: !newest, hint: "" };
  if (!newest) return { disabled: true, hint: "Book a guide and pay the deposit first: the simulated warning goes on your newest booking." };
  if (newest.status === "captured") return { disabled: false, hint: "" };
  if (NOT_PAID.includes(newest.status)) return { disabled: true, hint: "Pay for your newest booking first, then simulate: the warning is for a paid booking." };
  return { disabled: true, hint: `Can't simulate now: ${CANNOT_SIMULATE[newest.status] ?? `your newest booking is ${newest.status}`}.` };
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
