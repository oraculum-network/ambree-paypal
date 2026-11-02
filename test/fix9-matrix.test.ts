// Round 9: the ordering matrix. One refund (the whole 30.00 deposit, or 10.00 of it) whose first attempt
// reached PayPal and lost its reply, then every arrival order of the signals that can settle it:
//   R  the reply to the client's own retry (inside PayPalRestClient): PayPal replays its first reply (201),
//      refuses it (422 CAPTURE_FULLY_REFUNDED: the request id no longer deduped), or it is lost too;
//   W  the refund's webhook: PAYMENT.CAPTURE.REFUNDED (COMPLETED) or PAYMENT.REFUND.FAILED;
//   A  the agent's next refund_payment with the same arguments (only after a call that ended without a
//      definitive answer: after a 201 the refund is answered, and a further call is a new request);
//   G  a get_booking (which reads every pending refund by GET).
// And three things PayPal may have done with the refund: completed it at once, created it PENDING and then
// completed it, or created it PENDING and then failed it (at the moment its webhook is sent, W).
// R is held at the fake until its turn, so W, A and G may arrive before it; they queue on the booking.
// At the end, whatever the order:
//   - what PayPal refunded == refunded_minor + the amounts held for review (and no hold is left once the
//     refund's own webhook arrived, so it is exactly refunded_minor);
//   - never a second refund for one intent: PayPal refunded 0 or the intended amount, and a second operation
//     exists only once the first was resolved failed;
//   - no permanent hold, no permanent pending, nothing left `sending`;
//   - at most one unknown operation at every step.

import { describe, expect, it } from "vitest";
import type { Booking } from "../src/booking/service.ts";
import { runTool } from "../src/tools/registry.ts";
import { CONV, type World, deliver, eventType, keepWebhooks, paid, resourceOf, settle } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const FULLY_REFUNDED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "The capture has already been fully refunded." }] };

type Kind = "full" | "partial";
type Fate = "completed" | "pending→completed" | "pending→failed";
type Retry = "replayed 201" | "422 CAPTURE_FULLY_REFUNDED" | "lost";
type Signal = "R" | "W" | "A" | "G";

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

/** Operations whose outcome is unknown: still being sent, or held for review only because of that. */
const unknownOps = (b: Booking) => b.refund_ops.filter((o) => o.status === "sending" || (o.status === "needs_review" && (o as { review_cause?: string }).review_cause === "unknown"));

const ctx = (w: World) => ({ service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });

const CASES: Array<{ kind: Kind; fate: Fate; retry: Retry; order: Signal[] }> = [];
for (const kind of ["full", "partial"] as const)
  for (const fate of ["completed", "pending→completed", "pending→failed"] as const)
    for (const retry of ["replayed 201", "422 CAPTURE_FULLY_REFUNDED", "lost"] as const)
      for (const order of permutations<Signal>(retry === "replayed 201" ? ["R", "W", "G"] : ["R", "W", "A", "G"])) CASES.push({ kind, fate, retry, order });

async function run({ kind, fate, retry, order }: (typeof CASES)[number]) {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  const got = keepWebhooks(w);
  const amount = kind === "partial" ? "10.00" : undefined;
  const intended = kind === "partial" ? 1000 : 3000;
  const captureId = w.service.get(id)!.capture_id!;

  if (fate !== "completed") w.fake.pendNextRefund();
  // Attempt 1: PayPal makes the refund; the reply is lost.
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
  // Attempt 2, the client's own retry: answered only at R.
  let releaseR!: () => void;
  const wait = new Promise<void>((r) => (releaseR = r));
  if (retry === "replayed 201") w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true, wait });
  else if (retry === "lost") w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true, wait });
  else w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED, wait });

  const steps: Array<Promise<unknown>> = [w.service.refund(id, amount).catch((e: unknown) => e)];
  const webhooks: Array<Promise<{ status: number; result: string }>> = [];
  await settle();
  const [refundId] = w.fake.refundIds();
  expect(refundId).toBeDefined();
  const check = () => expect(unknownOps(w.service.get(id)!).length).toBeLessThanOrEqual(1);

  for (const s of order) {
    if (s === "R") releaseR();
    else if (s === "W") {
      if (fate !== "completed") w.fake.settleRefund(refundId!, fate === "pending→completed" ? "COMPLETED" : "FAILED");
      await w.fake.flush();
      const event = got.find((d) => resourceOf(d).id === refundId && eventType(d) === (fate === "pending→failed" ? "PAYMENT.REFUND.FAILED" : "PAYMENT.CAPTURE.REFUNDED"));
      expect(event).toBeDefined();
      webhooks.push(deliver(w, event!));
    } else if (s === "A") steps.push(runTool("refund_payment", amount ? { booking_id: id, amount } : { booking_id: id }, ctx(w)));
    else steps.push(runTool("get_booking", { booking_id: id }, ctx(w)));
    await settle();
    check();
  }
  await Promise.all(steps);
  const results = await Promise.all(webhooks);
  await w.fake.flush();
  check();

  const b = w.service.get(id)!;
  const refundedByPayPal = w.fake.refundedFrom(captureId);
  const held = b.refund_ops.filter((o) => o.status === "needs_review").reduce((s, o) => s + o.amount_minor, 0);
  // Money: what PayPal moved is what the booking counts (plus anything held for review).
  expect(refundedByPayPal).toBe(b.refunded_minor + held);
  // Never a second refund for one intent.
  expect([0, intended]).toContain(refundedByPayPal);
  if (b.refund_ops.length > 1) expect(b.refund_ops[0]!.status).toBe("failed");
  expect(b.refund_ops.length).toBeLessThanOrEqual(2);
  // The refund's own webhook arrived: no hold, no pending, nothing unknown is left.
  expect(held).toBe(0);
  expect(b.refund_ops.filter((o) => o.status === "pending" || o.status === "sending" || o.status === "needs_review")).toEqual([]);
  expect(b.status).toBe(refundedByPayPal === 0 ? "captured" : kind === "full" ? "refunded" : "partially_refunded");
  // The waiting move: withdrawn once money came back, otherwise answerable again.
  expect(b.reschedule?.status).toBe(refundedByPayPal === 0 ? "proposed" : "withdrawn");
  expect(w.service.summary(b)).toMatchObject({ refund_pending: null, refund_review: null, reschedule_hold: null });
  // The webhook was processed (not answered 500 for a redelivery).
  expect(results).toEqual([{ status: 200, result: "logged" }]);
  expect(w.ledger.verify().ok).toBe(true);
}

describe("the ordering matrix: one refund whose first reply was lost, every arrival order of the signals", () => {
  it.each(CASES.map((c) => [`${c.kind} · PayPal ${c.fate} · retry ${c.retry} · ${c.order.join(" ")}`, c] as const))("%s", async (_name, c) => {
    await run(c);
  });
});
