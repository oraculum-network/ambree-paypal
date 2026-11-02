// What the page says about a booking's payment. "Paid" only when PayPal said COMPLETED (status
// captured / refunded); pending, failed and mismatched captures say so instead. Pure, so it is unit-tested.

const money = (m) => (m ? `${m.currency_code} ${m.value}` : "");
const cents = (m) => Math.round(Number(m.value) * 100);

/**
 * A booking held for review because of a refund (`refund_review`) says that, and that the deposit was paid:
 * held only because PayPal gave no definitive answer about the refund (`refund_review_cause` "unknown"), so
 * it may have gone through; PayPal's notice may still settle it, and a person reconciles it if it doesn't
 * (the notice may never come, so the card promises none). Held because PayPal reports money refunded that
 * no refund this booking sent accounts for ("unexplained", round 10). Or because PayPal's reply about it
 * didn't match what was sent. One held because the order or capture didn't match the mandate says that.
 * @returns {{ testid: string, text: string } | null}
 */
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
      if (b.refund_review && b.refund_review_cause === "unknown") {
        return { testid: "refund-review", text: `A refund is held for review: PayPal gave no definitive answer about the refund of ${money(b.refund_review)}, so it may have gone through. Nothing more is refunded meanwhile: if PayPal's notice doesn't settle it, a person will reconcile it. The deposit, ${amount} to ${b.guide.name}, was paid (capture ${b.capture.id}).` };
      }
      if (b.refund_review && b.refund_review_cause === "unexplained") {
        return { testid: "refund-review", text: `A refund needs review: PayPal reports ${money(b.refund_review)} refunded on this booking that no refund this booking sent accounts for, so more may have come back to you than it shows. Nothing more is refunded until a person reconciles it. The deposit, ${amount} to ${b.guide.name}, was paid (capture ${b.capture.id}).` };
      }
      if (b.refund_review) {
        return { testid: "refund-review", text: `A refund needs review: PayPal's reply about the refund of ${money(b.refund_review)} didn't match what was sent, so nothing more is refunded until a person checks it. The deposit, ${amount} to ${b.guide.name}, was paid (capture ${b.capture.id}).` };
      }
      return { testid: "payment-review", text: `Payment needs review: PayPal's reply did not match the approved mandate (status ${b.capture.status ?? "unknown"}).` };
  }
}

/**
 * The card's line while a refund is being sent or is pending at PayPal (`refund_pending`), so the card
 * doesn't say only "Paid" while money is on its way back. Null otherwise.
 * @returns {{ testid: string, text: string } | null}
 */
export function refundLine(b) {
  if (!b.refund_pending) return null;
  return { testid: "refund-pending", text: `Refund under way: ${money(b.refund_pending)} back to you from ${b.guide.name}; PayPal hasn't confirmed it yet.` };
}

/**
 * The card's line for a move the agent proposed. "withdrawn": a refund of the deposit (part or all of it)
 * completed before the guide answered, so the move was closed (the guide's page no longer asks); the
 * reason follows what was refunded against what was captured (by the status only when the amounts aren't
 * given), since a booking held for review afterwards is neither status. A proposed move the guide can't
 * answer now (`reschedule_hold`: a refund under way, or a review) says why.
 * @returns {{ testid: string, text: string } | null}
 */
export function rescheduleLine(b) {
  const r = b.reschedule;
  if (!r) return null;
  if (r.status === "withdrawn") {
    const amounts = b.refunded && b.capture?.amount;
    const part = amounts ? cents(b.refunded) < cents(b.capture.amount) : b.status === "partially_refunded";
    const why = part ? "part of the deposit was refunded" : "the deposit was refunded";
    return { testid: "reschedule", text: `Reschedule to ${r.new_date}: withdrawn, because ${why}.` };
  }
  if (r.status === "proposed" && b.reschedule_hold) return { testid: "reschedule", text: `Reschedule to ${r.new_date}: proposed, but the guide can't answer it while ${b.reschedule_hold}.` };
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
 * sandbox it acts on the tab's newest booking, and only once that booking is paid (captured) with no refund
 * under way (`refund_pending`: being sent or pending at PayPal), as the server checks. Fake mode is
 * unchanged: any booking will do (it raises a demo-feed warning around all of them).
 * @returns {{ disabled: boolean, hint: string }}
 */
export function simulateControl(mode, bookings) {
  const newest = (bookings ?? []).at(-1);
  if (mode !== "sandbox") return { disabled: !newest, hint: "" };
  if (!newest) return { disabled: true, hint: "Book a guide and pay the deposit first: the simulated warning goes on your newest booking." };
  if (newest.status === "captured" && newest.refund_pending) return { disabled: true, hint: "Can't simulate now: a refund of the deposit has started, so the trip can't be moved." };
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
