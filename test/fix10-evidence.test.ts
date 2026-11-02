// Round 10 (DESIGN.md §19): R9-1..R9-5. Each depends on PayPal behaviour nobody has verified yet, so the
// app must be right under either premise:
//   I5  no refund evidence is dropped silently. A refund that names this booking (custom_id, or with none its
//       capture) and that no operation accounts for (its id is on no operation, and the operation whose
//       outcome is unknown, if any, doesn't match it: same amount and currency), read back by GET as
//       COMPLETED or PENDING, holds the booking for review ("unexplained"), with its id and amount; never
//       cleared automatically, nothing stacked on it. FAILED or CANCELLED: logged only.
//   F1  PayPal's seller_payable_breakdown.total_refunded_amount above what the booking accounts for holds it
//       as "unexplained" too; absent, the check is skipped.
//   F2  a refund names its booking by the capture in its `up` link when it carries no custom_id.
//   F3  every settle that leaves the booking refunded or partially refunded withdraws a waiting move.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import { SANDBOX_API_BASE } from "../src/paypal/sandbox.ts";
import { runTool } from "../src/tools/registry.ts";
import { expectMoneyTruth, heldMinor } from "./helpers/evidence.ts";
import { CONV, type World, deliver, eventType, keepWebhooks, kinds, paid, refundPosts, resourceOf } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";

const GUIDE = SEED_GUIDES[0]!.payee;
const MOVED = "2026-11-08";
const FULLY_REFUNDED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "The capture has already been fully refunded." }] };
const EXCEEDED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "The refund amount must be less than or equal to the capture amount that has not yet been refunded." }] };
const eur = (value: string) => ({ currency_code: "EUR" as const, value });

const ctx = (w: World) => ({ service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
const tool = (w: World, name: string, args: Record<string, unknown>) => runTool(name, args, ctx(w));
const row = (w: World, id: string, kind: string) => w.ledger.list(id).filter((e) => e.kind === kind).map((e) => e.data as Record<string, unknown>);
const ops = (w: World, id: string) => w.service.get(id)!.refund_ops as unknown as Array<Record<string, unknown>>;

/** Attempt `n` reaches PayPal (it acts on it) and its reply is lost. */
const loseReply = (w: World) => w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
/** The attempt never reaches PayPal (a dropped connection). */
const neverArrives = (w: World) => w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, network: true });
/** The next GET of a refund answers this body (PayPal's word on a refund the fake didn't make). */
const getAnswers = (w: World, body: object) => w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body });
const upLink = (captureId: string) => [
  { href: `${SANDBOX_API_BASE}/v2/payments/refunds/X`, rel: "self", method: "GET" },
  { href: `${SANDBOX_API_BASE}/v2/payments/captures/${captureId}`, rel: "up", method: "GET" },
];

/** Paid, a move proposed to the guide, the guide's refund offer; webhooks kept; the fake set to `premise`. */
async function offered(premise: { dedupe?: boolean; customId?: boolean; totals?: boolean } = {}) {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  const got = keepWebhooks(w);
  w.channels.drain(CONV);
  w.fake.dedupe = premise.dedupe ?? true;
  w.fake.refundCustomId = premise.customId ?? true;
  w.fake.refundTotals = premise.totals ?? true;
  const captureId = w.service.get(id)!.capture_id!;
  const eventFor = (refundId: string, type?: string) => got.find((d) => resourceOf(d).id === refundId && (!type || eventType(d) === type))!;
  return { w, id, token, got, captureId, eventFor };
}

describe("R9-1 / R9-4 (A): PayPal doesn't dedupe the client's retry, so a 10.00 refund goes out twice", () => {
  it("without total_refunded_amount: the first refund's webhook holds the booking for review as unexplained; nothing is dropped", async () => {
    const { w, id, eventFor } = await offered({ dedupe: false, totals: false });
    loseReply(w); // attempt 1 makes R1 and loses its reply; the client's retry makes R2 and is answered
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded", refunded_minor: 1000 });
    const [r1, r2] = w.fake.refundIds();
    expect(ops(w, id)).toMatchObject([{ n: 1, status: "completed", refund_id: r2 }]);
    await w.fake.flush();
    expect(await deliver(w, eventFor(r2!))).toEqual({ status: 200, result: "logged" }); // op 1's own refund
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 200, result: "logged" }); // no operation accounts for it
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", refunded_minor: 1000 });
    expect(w.service.summary(b)).toMatchObject({ refunded: eur("10.00"), refund_review: eur("10.00"), refund_review_cause: "unexplained" });
    expect(ops(w, id).map((o) => o.refund_id)).toEqual([r2, r1]);
    expectMoneyTruth(w, id);
    expect(row(w, id, "refund.unexplained")).toMatchObject([{ refund_id: r1, status: "COMPLETED", amount: eur("10.00"), held: true }]);
    // Nothing is stacked on it: the agent's next refund is refused, and says why.
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ code: "refund_under_review", message: expect.stringMatching(/no refund this booking sent accounts for/) });
    expect(refundPosts(w)).toBe(2);
    // A redelivery is a duplicate; the hold is counted once and never clears by itself.
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 200, result: "duplicate" });
    expect(await tool(w, "get_booking", { booking_id: id })).toMatchObject({ ok: true, value: { status: "needs_review", refund_review: eur("10.00") } });
    expectMoneyTruth(w, id);
  });

  it("with total_refunded_amount: the retry's own reply shows 20.00 refunded, so the booking is held at once; R1's webhook then names the 10.00, counted once", async () => {
    const { w, id, eventFor } = await offered({ dedupe: false });
    loseReply(w);
    const b = await w.service.refund(id, "10.00");
    expect(b).toMatchObject({ status: "needs_review", refunded_minor: 1000 });
    expect(w.service.summary(b)).toMatchObject({ refund_review: eur("10.00"), refund_review_cause: "unexplained" });
    expect(row(w, id, "refund.unexplained")).toMatchObject([{ source: "total_refunded_amount", total_refunded: eur("20.00"), accounted: eur("10.00") }]);
    expectMoneyTruth(w, id);
    await w.fake.flush();
    const [r1] = w.fake.refundIds();
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 200, result: "logged" });
    expect(heldMinor(w, id)).toBe(1000);
    expect(ops(w, id).map((o) => o.refund_id)).toContain(r1);
    expectMoneyTruth(w, id);
  });

  it("the agent's resend: the first send made R1 and lost its reply, the client's retry never arrived, the resend made R2: the same hold", async () => {
    const { w, id, eventFor } = await offered({ dedupe: false, totals: false });
    loseReply(w);
    neverArrives(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded", refunded_minor: 1000 });
    await w.fake.flush();
    const [r1] = w.fake.refundIds();
    await deliver(w, eventFor(r1!));
    expect(w.service.get(id)).toMatchObject({ status: "needs_review" });
    expect(heldMinor(w, id)).toBe(1000);
    expectMoneyTruth(w, id);
  });

  it("a GET that fails on that evidence answers 500 and records nothing; PayPal's redelivery records it", async () => {
    const { w, id, eventFor } = await offered({ dedupe: false, totals: false });
    loseReply(w);
    await w.service.refund(id, "10.00");
    await w.fake.flush();
    const [r1] = w.fake.refundIds();
    for (let i = 0; i < 2; i++) w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 500, body: {} });
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 500, result: "processing failed; PayPal will redeliver" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refund_ops: [{ status: "completed" }] });
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review" });
    expectMoneyTruth(w, id);
  });
});

describe("R9-4 (C2): a FAILED refund settles the unknown operation while a COMPLETED duplicate is unaccounted for", () => {
  /** R1 PENDING (attempt 1), R2 COMPLETED (the client's retry, not deduped); both replies lost; R1 then FAILED. */
  async function setup(totals: boolean) {
    const s = await offered({ dedupe: false, totals });
    s.w.fake.pendNextRefund();
    loseReply(s.w);
    loseReply(s.w);
    await expect(s.w.service.refund(s.id, "10.00")).rejects.toMatchObject({ kind: "network" });
    const [r1, r2] = s.w.fake.refundIds();
    s.w.fake.settleRefund(r1!, "FAILED");
    await s.w.fake.flush();
    return { ...s, r1: r1!, r2: r2!, failedEvent: s.eventFor(r1!, "PAYMENT.REFUND.FAILED"), completedEvent: s.eventFor(r2!, "PAYMENT.CAPTURE.REFUNDED") };
  }

  it("FAILED first: the operation fails; R2's webhook then holds the booking (unexplained); the agent's retry sends nothing", async () => {
    const { w, id, r2, failedEvent, completedEvent } = await setup(false);
    expect(await deliver(w, failedEvent)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "failed" }] });
    expect(await deliver(w, completedEvent)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0 });
    expect(ops(w, id)).toMatchObject([{ status: "failed" }, { status: "needs_review", review_cause: "unexplained", refund_id: r2, amount_minor: 1000 }]);
    expectMoneyTruth(w, id);
    expect(await tool(w, "refund_payment", { booking_id: id, amount: "10.00" })).toMatchObject({ ok: false, message: expect.stringMatching(/^refund_under_review: /) });
    expect(refundPosts(w)).toBe(2);
  });

  it("COMPLETED first: R2 settles the operation; R1's FAILED is logged only (refund.unexplained, held: false)", async () => {
    const { w, id, r1, r2, failedEvent, completedEvent } = await setup(false);
    expect(await deliver(w, completedEvent)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_ops: [{ status: "completed", refund_id: r2 }], reschedule: { status: "withdrawn" } });
    expect(await deliver(w, failedEvent)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_ops: [{ status: "completed" }] });
    expect(row(w, id, "refund.unexplained")).toMatchObject([{ refund_id: r1, status: "FAILED", held: false }]);
    expectMoneyTruth(w, id);
  });

  it("with total_refunded_amount: the FAILED refund's GET already shows R2's 10.00, so the booking is held even if R2's webhook never arrives", async () => {
    const { w, id, failedEvent } = await setup(true);
    expect(await deliver(w, failedEvent)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ status: "failed" }] });
    expect(heldMinor(w, id)).toBe(1000);
    expectMoneyTruth(w, id);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ code: "refund_under_review" });
  });
});

describe("R9-2 / R9-5: a refund webhook without custom_id finds its booking by the capture (F2)", () => {
  it("full refund held unknown after a refused retry: PAYMENT.CAPTURE.REFUNDED without custom_id settles it", async () => {
    const { w, id, got } = await offered({ customId: false });
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    await w.fake.flush();
    expect(resourceOf(got[0]!)).not.toHaveProperty("custom_id");
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ops: [{ status: "completed", refund_id: w.fake.refundIds()[0] }], reschedule: { status: "withdrawn" } });
    expect(w.service.summary(w.service.get(id)!)).toMatchObject({ refund_review: null });
    expectMoneyTruth(w, id);
  });

  it("PENDING then FAILED: PAYMENT.REFUND.FAILED without custom_id fails the held refund, frees the deposit, and the move can be answered", async () => {
    const { w, id, got } = await offered({ customId: false });
    w.fake.pendNextRefund();
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    w.fake.settleRefund(w.fake.refundIds()[0]!, "FAILED");
    await w.fake.flush();
    expect(got.map(eventType)).toEqual(["PAYMENT.REFUND.FAILED"]);
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [{ status: "failed" }], reschedule: { status: "proposed" } });
    expect(w.service.summary(b)).toMatchObject({ refund_review: null, reschedule_hold: null });
  });

  it("kept: a refund whose up link names another capture finds no booking; the held refund stays unknown", async () => {
    const { w, id, got } = await offered({ customId: false });
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", { id: "ROTHERCAPTURE001", status: "COMPLETED", amount: eur("30.00"), links: upLink("COTHERCAPTURE001") });
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "no matching booking" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refund_ops: [{ status: "needs_review", review_cause: "unknown" }] });
  });

  it("an event naming this capture whose GET names another capture is ignored (fail closed): the held refund stays unknown", async () => {
    const { w, id, got, captureId } = await offered({ customId: false });
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    const event = { id: "RCAPTURELINK0001", status: "COMPLETED", amount: eur("30.00"), links: upLink(captureId) };
    getAnswers(w, { ...event, links: upLink("COTHERCAPTURE001") });
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", event);
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ status: "needs_review", review_cause: "unknown" }] });
  });

  it("the card's held-unknown text promises no notice: if PayPal's notice doesn't settle it, a person will reconcile it", async () => {
    const { w, id } = await offered();
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review", message: expect.not.stringMatching(/until PayPal's notice settles it/) });
    const line = labels.paymentLine(w.service.summary(w.service.get(id)!));
    expect(line.testid).toBe("refund-review");
    expect(line.text).toMatch(/^A refund is held for review: PayPal gave no definitive answer about the refund of EUR 30\.00, so it may have gone through\./);
    expect(line.text).toMatch(/if PayPal's notice doesn't settle it, a person will reconcile it/);
    expect(line.text).not.toMatch(/until PayPal's notice settles it/);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review", message: expect.not.stringMatching(/until PayPal's notice settles it/) });
  });

  it("DEPLOY.md's webhook list has a TODO-CHECK for the refund failure events, to be read off the dashboard in spike S11", () => {
    const deploy = readFileSync(new URL("../DEPLOY.md", import.meta.url), "utf8");
    expect(deploy).toMatch(/TODO-CHECK[^\n]*refund failure events[^\n]*S11/);
    expect(deploy).toMatch(/PAYMENT\.REFUND\.\*/);
  });
});

describe("R9-3: whichever settle leaves money refunded closes a waiting move (F3)", () => {
  /** Op 1 (10.00) PENDING; op 2 (10.00, PENDING at PayPal) lost twice and its resend refused: held unknown; R1 then completes. */
  async function setup() {
    const s = await offered();
    s.w.fake.pendNextRefund();
    expect(await s.w.service.refund(s.id, "10.00")).toMatchObject({ refund_ops: [{ status: "pending" }] });
    s.w.fake.pendNextRefund();
    loseReply(s.w);
    loseReply(s.w);
    await expect(s.w.service.refund(s.id, "10.00")).rejects.toMatchObject({ kind: "network" });
    s.w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: EXCEEDED });
    await expect(s.w.service.refund(s.id, "10.00")).rejects.toMatchObject({ code: "refund_under_review" });
    const [r1, r2] = s.w.fake.refundIds();
    s.w.fake.settleRefund(r1!, "COMPLETED");
    await s.w.fake.flush();
    expect(await deliver(s.w, s.eventFor(r1!))).toEqual({ status: 200, result: "logged" });
    expect(s.w.service.get(s.id)).toMatchObject({ status: "needs_review", refunded_minor: 1000, reschedule: { status: "proposed" } });
    return { ...s, r2: r2! };
  }

  it("kept: while the other refund is held for review, the move stays as it was", async () => {
    const { w, id } = await setup();
    expect(w.service.summary(w.service.get(id)!)).toMatchObject({ reschedule: { status: "proposed" }, reschedule_hold: "the booking is held for review" });
    expect(kinds(w, id)).not.toContain("reschedule.withdrawn");
  });

  it("its FAILED evidence: partially refunded, and the move is withdrawn in the same save (reschedule.withdrawn)", async () => {
    const { w, id, r2, eventFor } = await setup();
    w.fake.settleRefund(r2, "FAILED");
    await w.fake.flush();
    expect(await deliver(w, eventFor(r2, "PAYMENT.REFUND.FAILED"))).toEqual({ status: 200, result: "logged" });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, reschedule: { status: "withdrawn" } });
    expect(row(w, id, "reschedule.withdrawn")).toMatchObject([{ to: MOVED, reason: "part of the deposit was refunded" }]);
    expect(labels.rescheduleLine(w.service.summary(b))).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: withdrawn, because part of the deposit was refunded.` });
  });

  it("its PENDING evidence: partially refunded, and the move is withdrawn", async () => {
    const { w, id, r2 } = await setup();
    const got = keepWebhooks(w);
    w.fake.emitWebhook("PAYMENT.REFUND.PENDING", "refund", { id: r2, status: "PENDING", amount: eur("10.00"), custom_id: id });
    await w.fake.flush();
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refund_ops: [{ status: "completed" }, { status: "pending" }], reschedule: { status: "withdrawn" } });
    expect(row(w, id, "reschedule.withdrawn")).toHaveLength(1);
  });
});

describe("I5: no refund evidence is dropped silently", () => {
  it("a COMPLETED refund of another amount while an operation's outcome is unknown doesn't match it: held unexplained, the operation stays unknown, and its own event still settles it", async () => {
    const { w, id, got } = await offered();
    loseReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    const other = { id: "RWRONGAMOUNT0092", status: "COMPLETED", amount: eur("5.00"), custom_id: id };
    getAnswers(w, other);
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", other);
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(ops(w, id)).toMatchObject([
      { n: 1, status: "needs_review", review_cause: "unknown" },
      { status: "needs_review", review_cause: "unexplained", refund_id: other.id, amount_minor: 500 },
    ]);
    expect(w.service.summary(w.service.get(id)!)).toMatchObject({ status: "needs_review", refund_review: eur("35.00"), refund_review_cause: "unexplained" });
    // Op 1's own event: it matches op 1, which completes; the booking stays held for the 5.00.
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 3000, refund_ops: [{ status: "completed", refund_id: w.fake.refundIds()[0] }, { review_cause: "unexplained" }] });
    expect(heldMinor(w, id)).toBe(500);
  });

  it("it names the booking only by its capture (no custom_id): held all the same", async () => {
    const { w, id, eventFor } = await offered({ dedupe: false, customId: false, totals: false });
    loseReply(w);
    await w.service.refund(id, "10.00");
    await w.fake.flush();
    const [r1] = w.fake.refundIds();
    expect(resourceOf(eventFor(r1!))).not.toHaveProperty("custom_id");
    expect(await deliver(w, eventFor(r1!))).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review" });
    expect(heldMinor(w, id)).toBe(1000);
    expectMoneyTruth(w, id);
  });

  it.each(["FAILED", "CANCELLED"] as const)("a %s refund no operation accounts for, none unknown: logged only (refund.unexplained, held: false)", async (status) => {
    const { w, id, got } = await offered();
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded" });
    const other = { id: `R${status}OOB000094`, status, amount: eur("5.00"), custom_id: id };
    getAnswers(w, other);
    w.fake.emitWebhook(`PAYMENT.REFUND.${status}`, "refund", other);
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refund_ops: [{ status: "completed" }] });
    expect(row(w, id, "refund.unexplained")).toMatchObject([{ refund_id: other.id, status, held: false }]);
  });

  it("a PENDING refund no operation accounts for is held too, and stays held when PayPal later fails it (never cleared automatically)", async () => {
    const { w, id, got, captureId } = await offered({ totals: false });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded" });
    w.fake.pendNextRefund();
    const oob = await w.payments.refundCapture(captureId, { amount: eur("5.00"), custom_id: id }, "out-of-band-1");
    w.fake.emitWebhook("PAYMENT.REFUND.PENDING", "refund", { id: oob.id, status: "PENDING", amount: eur("5.00"), custom_id: id });
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 1000 });
    expect(ops(w, id)).toMatchObject([{ status: "completed" }, { status: "needs_review", review_cause: "unexplained", refund_id: oob.id, amount_minor: 500 }]);
    w.fake.settleRefund(oob.id, "FAILED");
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    expect(await tool(w, "get_booking", { booking_id: id })).toMatchObject({ ok: true, value: { status: "needs_review", refund_review: eur("5.00"), refund_review_cause: "unexplained" } });
  });

  it("one refund, one entry: a refund held unexplained that the operation's own resend reply then names is folded into it", async () => {
    const { w, id, got } = await offered({ totals: false });
    loseReply(w);
    loseReply(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    const odd = { id: "RODDAMOUNT000096", status: "COMPLETED", amount: eur("5.00"), custom_id: id };
    getAnswers(w, odd);
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", odd);
    await w.fake.flush();
    await deliver(w, got.at(-1)!);
    expect(ops(w, id)).toMatchObject([{ n: 1, status: "sending" }, { review_cause: "unexplained", refund_id: odd.id }]);
    // The resend is answered with that very refund (PayPal refunded 5.00 for a 10.00 request).
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: odd });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "needs_review" });
    expect(ops(w, id)).toMatchObject([{ n: 1, status: "needs_review", review_cause: "mismatch", refund_id: odd.id }]);
  });

  it("a GET of a pending refund that answers another refund id is held as a mismatch, not recorded under the new id", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    await w.service.refund(id, "10.00");
    const [r1] = w.fake.refundIds();
    getAnswers(w, { id: "RANOTHERID000097", status: "COMPLETED", amount: eur("10.00"), custom_id: id });
    await w.service.refreshRefunds(id);
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ status: "needs_review", review_cause: "mismatch", refund_id: r1 }] });
  });
});

describe("F1: PayPal's total_refunded_amount", () => {
  it("kept: an operation pending or unknown counts as accounted, so its money in PayPal's total holds nothing", async () => {
    const { w, id, eventFor } = await offered();
    w.fake.pendNextRefund();
    await w.service.refund(id, "10.00"); // op 1: R1 PENDING
    loseReply(w);
    loseReply(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" }); // op 2: R2 COMPLETED, unknown
    const [r1, r2] = w.fake.refundIds();
    w.fake.settleRefund(r1!, "COMPLETED"); // R1's GET now shows 20.00 refunded: op 1's and op 2's
    expect(await w.service.refreshRefunds(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000 });
    expect(heldMinor(w, id)).toBe(0);
    await w.fake.flush();
    await deliver(w, eventFor(r2!));
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 2000 });
    expect(kinds(w, id)).not.toContain("refund.unexplained");
    expectMoneyTruth(w, id);
  });

  it("kept: a total in another currency than the capture's is ignored", async () => {
    const { w, id } = await offered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RUSDTOTAL0000098", status: "COMPLETED", amount: eur("10.00"), seller_payable_breakdown: { total_refunded_amount: { currency_code: "USD", value: "25.00" } } } });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded" });
  });
});

describe("the card and the agent say what an unexplained hold is", () => {
  const base = { booking_id: "bk_1", status: "needs_review", guide: { name: "Lantern Ridge Walks (demo)" }, capture: { id: "C1", amount: eur("30.00"), status: "COMPLETED" }, refunded: eur("10.00") };

  it("refund_review_cause unexplained: PayPal reports more refunded than this booking's refunds account for; not 'didn't match what was sent'", () => {
    const line = labels.paymentLine({ ...base, refund_review: eur("10.00"), refund_review_cause: "unexplained" });
    expect(line.testid).toBe("refund-review");
    expect(line.text).toBe(
      "A refund needs review: PayPal reports EUR 10.00 refunded on this booking that no refund this booking sent accounts for, so more may have come back to you than it shows. Nothing more is refunded until a person reconciles it. The deposit, EUR 30.00 to Lantern Ridge Walks (demo), was paid (capture C1).",
    );
  });

  it("get_booking's description names the cause", async () => {
    const { findTool } = await import("../src/tools/registry.ts");
    expect(findTool("get_booking")!.description).toMatch(/unexplained/);
  });
});

void GUIDE;
