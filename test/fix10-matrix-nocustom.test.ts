// Round 10: round 9's ordering matrix (test/fix9-matrix.test.ts) under the no-custom_id premise (R9-2, R9-5):
// PayPal's refund resources (the POST reply, GET and every refund webhook) carry no custom_id, only their
// `up` link to the capture. PayPal dedupes the repeated PayPal-Request-Id, as in round 9 (the not-deduped
// premise is test/fix10-matrix-nodedupe.test.ts). The same 324 cases: a full or 10.00-of-30.00 refund whose
// first attempt reached PayPal and lost its reply; PayPal completed it, or created it PENDING and then
// completed or failed it; the client's retry replayed (201), refused 422, or lost; then every order of
//   R  the retry's reply,  W  the refund's webhook (found by its capture, F2),  A  the agent's resend,
//   G  a get_booking.
// At the end, whatever the order, the same as round 9 (the refund's own webhook arrived, so nothing is held)
// and the money truth: PayPal's completed refunds == refunded_minor + every amount held for review (none).

import { describe, expect, it } from "vitest";
import type { Booking } from "../src/booking/service.ts";
import { runTool } from "../src/tools/registry.ts";
import { expectMoneyTruth, heldMinor, paypalRefunds } from "./helpers/evidence.ts";
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
  w.fake.refundCustomId = false;
  const amount = kind === "partial" ? "10.00" : undefined;
  const intended = kind === "partial" ? 1000 : 3000;
  const captureId = w.service.get(id)!.capture_id!;

  if (fate !== "completed") w.fake.pendNextRefund();
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
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
      expect(resourceOf(event!)).not.toHaveProperty("custom_id");
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
  expectMoneyTruth(w, id);
  expect([0, intended]).toContain(refundedByPayPal);
  if (b.refund_ops.length > 1) expect(b.refund_ops[0]!.status).toBe("failed");
  expect(b.refund_ops.length).toBeLessThanOrEqual(2);
  // Every refund PayPal completed is on the booking, once.
  const ids = b.refund_ops.map((o) => o.refund_id).filter((x): x is string => Boolean(x));
  expect(new Set(ids).size).toBe(ids.length);
  for (const r of await paypalRefunds(w)) if (r.status === "COMPLETED") expect(ids).toContain(r.id);
  // The refund's own webhook arrived (found by its capture): nothing is held, pending or unknown.
  expect(heldMinor(w, id)).toBe(0);
  expect(b.refund_ops.filter((o) => o.status === "pending" || o.status === "sending" || o.status === "needs_review")).toEqual([]);
  expect(b.status).toBe(refundedByPayPal === 0 ? "captured" : kind === "full" ? "refunded" : "partially_refunded");
  expect(b.reschedule?.status).toBe(refundedByPayPal === 0 ? "proposed" : "withdrawn");
  expect(w.service.summary(b)).toMatchObject({ refund_pending: null, refund_review: null, reschedule_hold: null });
  expect(results).toEqual([{ status: 200, result: "logged" }]);
  expect(w.ledger.verify().ok).toBe(true);
}

describe("the ordering matrix without custom_id: the refund's webhook finds the booking by its capture", () => {
  it.each(CASES.map((c) => [`${c.kind} · PayPal ${c.fate} · retry ${c.retry} · ${c.order.join(" ")}`, c] as const))("%s", async (_name, c) => {
    await run(c);
  });
});
