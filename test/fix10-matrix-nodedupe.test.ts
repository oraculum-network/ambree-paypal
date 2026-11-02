// Round 10: the ordering matrix under the not-deduped premise (R9-1, R9-4): PayPal treats a repeated
// PayPal-Request-Id as a new request, so the client's own retry, and the agent's resend, can each make
// another refund. Run with and without custom_id on refund resources, and with and without
// seller_payable_breakdown.total_refunded_amount (F1): the money must come out the same either way.
//
// One refund (the whole 30.00, or 10.00 of it). Attempt 1 reaches PayPal and makes R1, and its reply is lost.
// PayPal completes R1 at once, or makes it PENDING and later completes or fails it (at W1). The client's
// retry reaches PayPal at once (for 10.00 it makes R2, completed at once; for the whole deposit PayPal
// refuses it 422 CAPTURE_FULLY_REFUNDED, as nothing is left), and its reply is either answered or lost at R.
// Then every arrival order of:
//   R   the retry's reply (held at the fake until its turn; W1, W2 and A queue behind the call meanwhile);
//   W1  R1's webhook (PAYMENT.CAPTURE.REFUNDED, or PAYMENT.REFUND.FAILED);
//   W2  R2's PAYMENT.CAPTURE.REFUNDED (10.00 only);
//   A   the agent's next refund_payment, same arguments (not after a 201, which answered the call). A resend
//       PayPal doesn't dedupe makes yet another refund (R3) if the capture has room;
// then every other refund webhook PayPal sent (R3's) arrives too. A get_booking isn't a signal here: no
// operation is ever PENDING in this grid (R2 and R3 complete at once), so it reads nothing.
// At the end, whatever the order: PayPal's completed refunds == refunded_minor + every amount held for review
// (the money truth); every refund PayPal completed is on the booking exactly once (on its operation, or
// held as unexplained); nothing is left pending, sending or unknown; at most 3 refund POSTs (attempt 1,
// the retry, and one resend or one new refund after the first failed); held money means needs_review, and
// otherwise the status and the move follow the money. At every step: at most one unknown operation.

import { describe, expect, it } from "vitest";
import type { Booking } from "../src/booking/service.ts";
import { runTool } from "../src/tools/registry.ts";
import { expectMoneyTruth, heldMinor, paypalRefunds } from "./helpers/evidence.ts";
import { CONV, type Delivery, type World, deliver, eventType, keepWebhooks, paid, refundPosts, resourceOf, settle } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";

type Kind = "full" | "partial";
type Fate = "completed" | "pending→completed" | "pending→failed";
type Retry = "answered" | "lost";
type Signal = "R" | "W1" | "W2" | "A";

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const unknownOps = (b: Booking) => b.refund_ops.filter((o) => o.status === "sending" || (o.status === "needs_review" && (o as { review_cause?: string }).review_cause === "unknown"));
const ctx = (w: World) => ({ service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
const eventId = (d: Delivery) => (JSON.parse(d.raw) as { id: string }).id;

type Case = { kind: Kind; fate: Fate; retry: Retry; customId: boolean; totals: boolean; order: Signal[] };
const CASES: Case[] = [];
for (const customId of [true, false])
  for (const totals of [true, false])
    for (const kind of ["full", "partial"] as const)
      for (const fate of ["completed", "pending→completed", "pending→failed"] as const)
        for (const retry of ["answered", "lost"] as const) {
          const signals: Signal[] = kind === "full" ? ["R", "W1", "A"] : retry === "answered" ? ["R", "W1", "W2"] : ["R", "W1", "W2", "A"];
          for (const order of permutations(signals)) CASES.push({ kind, fate, retry, customId, totals, order });
        }

async function run({ kind, fate, retry, customId, totals, order }: Case) {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  const got = keepWebhooks(w);
  w.fake.dedupe = false;
  w.fake.refundCustomId = customId;
  w.fake.refundTotals = totals;
  const amount = kind === "partial" ? "10.00" : undefined;

  if (fate !== "completed") w.fake.pendNextRefund();
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
  let releaseR!: () => void;
  const replyAfter = new Promise<void>((r) => (releaseR = r));
  if (retry === "answered") w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true, replyAfter });
  else w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true, replyAfter });

  const steps: Array<Promise<unknown>> = [w.service.refund(id, amount).catch((e: unknown) => e)];
  const webhooks: Array<Promise<{ status: number; result: string }>> = [];
  const delivered = new Set<string>();
  const send = (d: Delivery | undefined) => {
    expect(d).toBeDefined();
    delivered.add(eventId(d!));
    webhooks.push(deliver(w, d!));
  };
  await settle();
  const [r1, r2] = w.fake.refundIds();
  expect(r1).toBeDefined();
  expect(r2 === undefined).toBe(kind === "full");
  const check = () => expect(unknownOps(w.service.get(id)!).length).toBeLessThanOrEqual(1);

  for (const s of order) {
    if (s === "R") releaseR();
    else if (s === "W1") {
      if (fate !== "completed") w.fake.settleRefund(r1!, fate === "pending→completed" ? "COMPLETED" : "FAILED");
      await w.fake.flush();
      send(got.find((d) => resourceOf(d).id === r1 && eventType(d) === (fate === "pending→failed" ? "PAYMENT.REFUND.FAILED" : "PAYMENT.CAPTURE.REFUNDED")));
    } else if (s === "W2") {
      await w.fake.flush();
      send(got.find((d) => resourceOf(d).id === r2 && eventType(d) === "PAYMENT.CAPTURE.REFUNDED"));
    } else steps.push(runTool("refund_payment", amount ? { booking_id: id, amount } : { booking_id: id }, ctx(w)));
    await settle();
    check();
  }
  await Promise.all(steps);
  await w.fake.flush();
  for (const d of got) if (!delivered.has(eventId(d))) send(d);
  const results = await Promise.all(webhooks);
  await w.fake.flush();
  check();

  const b = w.service.get(id)!;
  // The money truth.
  expectMoneyTruth(w, id);
  // Every refund PayPal completed is on the booking, once (its operation's, or held as unexplained).
  const ids = b.refund_ops.map((o) => o.refund_id).filter((x): x is string => Boolean(x));
  expect(new Set(ids).size).toBe(ids.length);
  for (const r of await paypalRefunds(w)) if (r.status === "COMPLETED") expect(ids).toContain(r.id);
  expect(refundPosts(w)).toBeLessThanOrEqual(3);
  expect(b.refund_ops.filter((o) => o.status === "pending" || o.status === "sending")).toEqual([]);
  expect(unknownOps(b)).toEqual([]);
  // Held money means review; otherwise the status and the move follow the money.
  if (heldMinor(w, id) > 0) {
    expect(b.status).toBe("needs_review");
    if (b.reschedule?.status === "withdrawn") expect(b.refunded_minor).toBeGreaterThan(0);
    else expect(b.reschedule?.status).toBe("proposed");
  } else {
    expect(b.status).toBe(b.refunded_minor === 0 ? "captured" : b.refunded_minor >= 3000 ? "refunded" : "partially_refunded");
    expect(b.reschedule?.status).toBe(b.refunded_minor === 0 ? "proposed" : "withdrawn");
  }
  expect(w.service.summary(b)).toMatchObject({ refund_pending: null });
  for (const r of results) expect(r).toEqual({ status: 200, result: "logged" });
  expect(w.ledger.verify().ok).toBe(true);
}

describe("the ordering matrix when PayPal doesn't dedupe a repeated PayPal-Request-Id", () => {
  it.each(CASES.map((c) => [`${c.kind} · PayPal ${c.fate} · retry ${c.retry} · custom_id ${c.customId ? "on" : "off"} · totals ${c.totals ? "on" : "off"} · ${c.order.join(" ")}`, c] as const))(
    "%s",
    async (_name, c) => {
      await run(c);
    },
  );
});
