// Round 10's last two findings (DESIGN.md §19, "After round 10"):
// - PAYMENT.CAPTURE.REVERSED is subscribed, and its resource is a refund (PayPal's event-names page lists
//   "Show refund details" for it, as for REFUNDED; unverified until spike S11). Such a refund is refund
//   evidence like any other: no refund this booking sent accounts for it, so it holds the booking (I5).
// - The resend texts promise only what the code can keep: the same PayPal-Request-Id, and a review hold if
//   PayPal reports a second refund anyway; not "never refunds twice" (dedupe is unverified).

import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/loop.ts";
import { findTool, runTool } from "../src/tools/registry.ts";
import { expectMoneyTruth } from "./helpers/evidence.ts";
import { CONV, type World, deliver, keepWebhooks, paid } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const ctx = (w: World) => ({ service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
const tool = (w: World, name: string, args: Record<string, unknown>) => runTool(name, args, ctx(w));
const row = (w: World, id: string, kind: string) => w.ledger.list(id).filter((e) => e.kind === kind).map((e) => e.data as Record<string, unknown>);

/** Paid, a move proposed to the guide; webhooks kept. */
async function booked(customId: boolean) {
  const w = makeWorld();
  const { id } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  const got = keepWebhooks(w);
  w.channels.drain(CONV);
  w.fake.refundCustomId = customId;
  w.fake.refundTotals = false;
  return { w, id, got, captureId: w.service.get(id)!.capture_id! };
}

describe("PAYMENT.CAPTURE.REVERSED with a refund resource is refund evidence", () => {
  it.each([true, false])("custom_id present: %s. The reversal holds the booking (unexplained); the move is no longer answerable", async (customId) => {
    const { w, id, got, captureId } = await booked(customId);
    // PayPal reverses the capture (a dispute or chargeback): money goes back to the buyer without our asking.
    const reversal = await w.payments.refundCapture(captureId, {}, "paypal-reversal-1");
    const resource = await w.payments.getRefund(reversal.id);
    w.fake.emitWebhook("PAYMENT.CAPTURE.REVERSED", "refund", resource);
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", refunded_minor: 0 });
    expect(w.service.summary(b)).toMatchObject({ refund_review: { currency_code: "EUR", value: "30.00" }, refund_review_cause: "unexplained" });
    expect(row(w, id, "refund.unexplained")).toMatchObject([{ refund_id: reversal.id, status: "COMPLETED", held: true }]);
    expectMoneyTruth(w, id);
    // Nobody is told the deposit carries over: the move can't be answered or proposed again.
    await expect(w.service.proposeReschedule(id, "2026-11-09")).rejects.toMatchObject({ code: "wrong_state" });
  });

  it("kept: a PAYMENT.CAPTURE.REVERSED whose resource is a capture still goes to the capture refresh (200, nothing weighed as a refund)", async () => {
    const { w, id, got, captureId } = await booked(true);
    w.fake.emitWebhook("PAYMENT.CAPTURE.REVERSED", "capture", { id: captureId, status: "REVERSED", custom_id: id });
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(row(w, id, "refund.unexplained")).toEqual([]);
  });
});

describe("the resend texts promise only what the code keeps", () => {
  it("refund_unconfirmed, refund_payment's description and the system prompt: same PayPal-Request-Id, a hold if PayPal makes a second refund; never 'never refunds twice'", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    const out = await tool(w, "refund_payment", { booking_id: id });
    expect(out.ok).toBe(false);
    const msg = (out as { message: string }).message;
    for (const text of [msg, systemPrompt("2026-11-03"), findTool("refund_payment")!.description]) {
      expect(text).not.toMatch(/never refunds twice/);
      expect(text).toMatch(/same PayPal-Request-Id/);
      expect(text).toMatch(/held for review/);
    }
  });
});
