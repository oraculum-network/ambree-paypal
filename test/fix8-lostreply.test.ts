// Round 8, D3: a refund whose reply was lost. PayPal refunded, but both of the client's attempts lost the
// reply, so the operation stays `sending` and the agent was told only "PayPal error … network". PayPal's
// PAYMENT.CAPTURE.REFUNDED for that refund names the booking (custom_id). The webhook now records it on
// the sending operation: the refund is read back by GET (no new refund is sent) and goes through
// #applyRefund, which fails closed. If it can't be read, the webhook answers 500 and PayPal redelivers.
// A resend of an operation already sent that PayPal refuses outright holds the booking for review: the
// first send may already have refunded the money, so the reservation is not released.

import { describe, expect, it } from "vitest";
import { BookingService } from "../src/booking/service.ts";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import type { FakeApp } from "../src/paypal/fake.ts";
import { CONV, DATE, type World, kinds, paid, refundPosts } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const GUIDE = SEED_GUIDES[0]!.payee;
type Delivery = { raw: string; headers: Record<string, string>; to?: FakeApp };

/** Webhooks are kept, not delivered: each test hands them to the service itself. */
function keepWebhooks(w: World): Delivery[] {
  const got: Delivery[] = [];
  w.fake.deliver = (raw, headers, to) => void got.push({ raw, headers, to });
  return got;
}
/** To the endpoint of the app whose webhook it came on (a refund's: the guide's; DESIGN.md §21). */
const deliver = (w: World, d: Delivery) => w.webhook(d);
const resourceId = (d: Delivery) => (JSON.parse(d.raw) as { resource: { id: string } }).resource.id;

/** Both of the client's attempts reach PayPal and lose the reply. */
function loseBothReplies(w: World) {
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
}

/** Paid, a move proposed, the guide's offer, and a full refund whose replies were lost. */
async function lostFullRefund() {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  const got = keepWebhooks(w);
  loseBothReplies(w);
  await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
  await w.fake.flush();
  expect(w.service.get(id)).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [{ n: 1, status: "sending" }] });
  expect(w.fake.balance(GUIDE)).toBe(0); // PayPal did refund it
  expect(got.map((d) => (JSON.parse(d.raw) as { event_type: string }).event_type)).toEqual(["PAYMENT.CAPTURE.REFUNDED"]);
  w.channels.drain(CONV);
  return { w, id, token, got };
}

describe("D3: the refund event of a refund whose reply was lost is recorded on its operation", () => {
  it("PAYMENT.CAPTURE.REFUNDED: refunded, the operation completed with the event's refund, the move withdrawn; nothing is sent again", async () => {
    const { w, id, got } = await lostFullRefund();
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    const refundId = resourceId(got[0]!);
    expect(w.service.get(id)).toMatchObject({
      status: "refunded",
      refunded_minor: 3000,
      refund_ids: [refundId],
      refund_ops: [{ n: 1, status: "completed", refund_id: refundId, amount_minor: 3000 }],
      reschedule: { new_date: MOVED, status: "withdrawn" },
      date: DATE,
    });
    expect(refundPosts(w)).toBe(2); // the two lost attempts; the webhook sends nothing
    const k = kinds(w, id);
    expect(k.indexOf("webhook.PAYMENT.CAPTURE.REFUNDED")).toBeLessThan(k.indexOf("refund.completed"));
    expect(k.filter((x) => x === "refund.completed")).toHaveLength(1);
    expect(w.ledger.list(id).find((e) => e.kind === "refund.recovered")!.data).toMatchObject({ n: 1, refund_id: refundId });
    // The agent hears of it, and the traveller's card no longer says only "Paid".
    expect(w.channels.drain(CONV).filter((e) => e.type === "refunded").map((e) => e.text)).toEqual([expect.stringMatching(/^Refunded EUR 30\.00 .*withdrawn/)]);
    expect(w.service.summary(w.service.get(id)!)).toMatchObject({ refunded: { value: "30.00" }, refund_pending: null });
    // PayPal's redelivery is a duplicate. Round 9 (I3): the agent's next refund_payment, its answer to the
    // call that lost the reply, reports that refund and sends nothing; a call after that says there is
    // nothing left.
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "duplicate" });
    expect(await w.service.refundPayment(id)).toMatchObject({ booking: { status: "refunded" }, acknowledged: { n: 1, status: "completed" } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
    expect(refundPosts(w)).toBe(2);
    expect(w.ledger.verify().ok).toBe(true);
  });

  it("the refund can't be read back: 500 (PayPal redelivers), nothing changed; the redelivery records it", async () => {
    const { w, id, got } = await lostFullRefund();
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 500, body: {} });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 500, body: {} });
    expect(await deliver(w, got[0]!)).toMatchObject({ status: 500 });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "sending" }] });
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refund_ops: [{ status: "completed" }] });
    expect(kinds(w, id).filter((x) => x === "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1);
  });

  it("an event about a refund already known leaves the one being sent alone; its own event records it", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    const got = keepWebhooks(w);
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded" });
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    expect(got).toHaveLength(2); // the 10.00 refund's event, then the lost 20.00 refund's
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_ops: [{ status: "completed" }, { n: 2, status: "sending" }] });
    expect(await deliver(w, got[1]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ops: [{ status: "completed" }, { n: 2, status: "completed", refund_id: resourceId(got[1]!), amount_minor: 2000 }] });
    expect(refundPosts(w)).toBe(3);
  });

  it("fails closed: a refund event whose amount isn't the operation's holds the booking for review", async () => {
    const { w, id } = await lostFullRefund();
    const results: Array<{ status: number; result: string }> = [];
    w.fake.deliver = async (raw, headers) => void results.push(await w.service.handleWebhook(raw, headers));
    const other = { id: "ROTHER0000000081", status: "COMPLETED", amount: { currency_code: "EUR", value: "5.00" }, custom_id: id };
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: other });
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", other);
    await w.fake.flush();
    expect(results).toEqual([{ status: 200, result: "logged" }]);
    // Round 10 (I5): another amount doesn't match the operation, so the refund is held as its own unexplained
    // entry, and the operation's outcome stays unknown (its own event can still settle it).
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ n: 1, status: "sending" }, { status: "needs_review", review_cause: "unexplained", refund_id: other.id }] });
    expect(w.channels.drain(CONV).some((e) => e.type === "refunded")).toBe(false);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
  });
});

describe("D3: a resend PayPal refuses outright holds the booking for review; the reservation stays", () => {
  it("422 CAPTURE_FULLY_REFUNDED on the resend: needs_review, still reserved, no further refund", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "The capture has already been fully refunded." }] } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review", message: expect.stringMatching(/may already have been refunded/) });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ n: 1, status: "needs_review" }] });
    expect(BookingService.reservedMinor(b)).toBe(3000);
    const k = kinds(w, id);
    expect(k).toContain("refund.resend_refused");
    expect(k).not.toContain("refund.failed");
    expect(w.service.summary(b)).toMatchObject({ refund_review: { currency_code: "EUR", value: "30.00" }, refund_pending: null });
    await expect(w.service.refund(id, "5.00")).rejects.toMatchObject({ code: "refund_under_review" });
    expect(refundPosts(w)).toBe(3);
  });

  it("kept: a first send PayPal refuses outright is failed and frees the reservation", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED", description: "refused" }] } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ status: 422 });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "failed" }] });
    expect((await w.service.refund(id)).status).toBe("refunded");
  });
});
