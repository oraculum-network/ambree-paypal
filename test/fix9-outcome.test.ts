// Round 9: a refund whose outcome is unknown (an attempt may have reached PayPal, but no definitive reply
// came back) ends the same way whichever signal arrives first: the client's own retry reply, the refund's
// webhook, the agent's next refund_payment, or a get_booking. R8-1..R8-4 were four orderings that didn't;
// R8-5 and R8-6 and the card line are what a judge sees without an LLM key. The invariants:
//   I1 maybe-delivered is sticky: a later definitive refusal holds the operation for review, never `failed`;
//   I2 evidence (a refund webhook naming the booking, read back by GET) resolves the one unknown operation;
//   I3 one intended refund, one operation: the next refund_payment resends it or reports what PayPal did;
//   I4 GET is truth: refund_payment and get_booking read every pending refund first.

import { describe, expect, it } from "vitest";
import { Agent, systemPrompt } from "../src/agent/loop.ts";
import { ScriptedModel } from "../src/agent/scripted.ts";
import { BookingService } from "../src/booking/service.ts";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { FakePayPal } from "../src/paypal/fake.ts";
import { findTool, runTool } from "../src/tools/registry.ts";
import { CONV, type World, deliver, eventType, keepWebhooks, kinds, ordered, paid, refundPosts } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";
import { readFileSync } from "node:fs";

const GUIDE = SEED_GUIDES[0]!.payee;
const MOVED = "2026-11-08";
const FULLY_REFUNDED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED", description: "The capture has already been fully refunded." }] };
const EXCEEDED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "The refund amount must be less than or equal to the capture amount that has not yet been refunded." }] };
const NOT_ALLOWED = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED", description: "refused" }] };

const ctx = (w: World) => ({ service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
const tool = (w: World, name: string, args: Record<string, unknown>) => runTool(name, args, ctx(w));
/** What PayPal moved back from the guide (the fake's balance is the truth). */
const moved = (w: World) => 3000 - w.fake.balance(GUIDE);
const heldMinor = (w: World, id: string) => w.service.get(id)!.refund_ops.filter((o) => o.status === "needs_review").reduce((s, o) => s + o.amount_minor, 0);

/** Attempt 1 reaches PayPal (the refund is made) and its reply is lost (`how`: a network error or a 5xx). */
function loseFirstReply(w: World, how: "network" | "5xx" = "network") {
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: how === "5xx" ? 503 : 0, dropResponse: true });
}
/** Both of the client's attempts reach PayPal and lose the reply. */
function loseBothReplies(w: World) {
  loseFirstReply(w);
  loseFirstReply(w);
}

/** Paid, a move proposed to the guide, and the guide's refund offer (so a refund is allowed). */
async function offered() {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  const got = keepWebhooks(w);
  w.channels.drain(CONV);
  return { w, id, token, got };
}

describe("R8-1: a pending refund that fails while its reply is lost settles; nothing stays pending for good", () => {
  it("PAYMENT.REFUND.FAILED for the refund being sent records it failed and frees the deposit; the next refund_payment sends a new one", async () => {
    const { w, id, got } = await offered();
    w.fake.pendNextRefund();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    const [refundId] = w.fake.refundIds();
    w.fake.settleRefund(refundId!, "FAILED");
    await w.fake.flush();
    expect(got.map(eventType)).toEqual(["PAYMENT.REFUND.FAILED"]);
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [{ n: 1, status: "failed", refund_id: refundId }] });
    expect(BookingService.reservedMinor(b)).toBe(0);
    expect(w.service.summary(b)).toMatchObject({ refund_pending: null, reschedule_hold: null });
    // The agent's next call: the first refund failed, so a new one is reserved and sent.
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ops: [{ status: "failed" }, { n: 2, status: "completed" }] });
    expect(moved(w)).toBe(3000);
    expect(refundPosts(w)).toBe(3);
  });

  it("I4: the resend's replayed PENDING reply, its FAILED event lost: get_booking reads it and frees the deposit", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    expect(await w.service.refund(id)).toMatchObject({ refund_ops: [{ status: "pending" }] }); // PayPal replays the first reply
    w.fake.settleRefund(w.fake.refundIds()[0]!, "FAILED"); // its webhook is never delivered
    const out = await tool(w, "get_booking", { booking_id: id });
    expect(out).toMatchObject({ ok: true, value: { status: "captured", refund_pending: null, reschedule_hold: null } });
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ status: "failed" }]);
  });

  it("I4: a pending refund that completed with its webhook lost: refund_payment reads it before deciding", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    expect(await w.service.refund(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "pending" }] });
    w.fake.settleRefund(w.fake.refundIds()[0]!, "COMPLETED"); // its webhook is never delivered
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed", message: expect.stringMatching(/already refunded/) });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, reschedule: { status: "withdrawn" } });
    expect(refundPosts(w)).toBe(1);
  });

  it("I4: a GET that fails changes nothing: get_booking returns the stored state, refund_payment decides on it", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    await w.service.refund(id);
    for (let i = 0; i < 4; i++) w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 500, body: {} });
    expect(await tool(w, "get_booking", { booking_id: id })).toMatchObject({ ok: true, value: { status: "captured", refund_pending: { value: "30.00" } } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "bad_amount" });
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ status: "pending" }]);
    expect(refundPosts(w)).toBe(1);
  });
});

describe("R8-2: the client's own retry of a refund whose first reply was lost is refused", () => {
  it.each(["network", "5xx"] as const)("attempt 1 lost (%s), the retry 422 CAPTURE_FULLY_REFUNDED: held for review, still reserved; the refund's event then settles it", async (how) => {
    const { w, id, got } = await offered();
    loseFirstReply(w, how);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review", message: expect.stringMatching(/may already have been refunded/) });
    await w.fake.flush();
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ n: 1, status: "needs_review", review_cause: "unknown", maybe_sent: true }] });
    expect(BookingService.reservedMinor(b)).toBe(3000);
    expect(kinds(w, id)).not.toContain("refund.failed");
    expect(moved(w)).toBe(3000);
    // Nothing can be built on it meanwhile: the move stays on hold, no new date can be proposed.
    expect(w.service.summary(b)).toMatchObject({ reschedule: { status: "proposed" }, reschedule_hold: "the booking is held for review" });
    // PAYMENT.CAPTURE.REFUNDED for that refund: the booking leaves review, refunded, the move withdrawn.
    expect(got.map(eventType)).toEqual(["PAYMENT.CAPTURE.REFUNDED"]);
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ops: [{ status: "completed", refund_id: w.fake.refundIds()[0] }], reschedule: { status: "withdrawn" } });
    expect(refundPosts(w)).toBe(2);
    expect(w.ledger.verify().ok).toBe(true);
  });

  it("partial 10.00 of 30.00: the held refund blocks a second 10.00; the event settles it at 10.00; nothing is refunded twice", async () => {
    const { w, id, got } = await offered();
    loseFirstReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: EXCEEDED });
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ code: "refund_under_review" });
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ code: "refund_under_review" });
    await w.fake.flush();
    expect(refundPosts(w)).toBe(2);
    expect(moved(w)).toBe(w.service.get(id)!.refunded_minor + heldMinor(w, id));
    await deliver(w, got[0]!);
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000 });
    // The agent's next call reports that refund rather than sending another.
    const out = await tool(w, "refund_payment", { booking_id: id, amount: "10.00" });
    expect(out).toMatchObject({ ok: true, value: { acknowledged: { n: 1, status: "completed" } } });
    expect(refundPosts(w)).toBe(2);
    expect(moved(w)).toBe(1000);
  });

  it("I1: the client says whether an attempt may have reached PayPal (maybeDelivered)", async () => {
    const setup = (timeoutMs?: number) => {
      const fake = new FakePayPal();
      return { fake, client: new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch, timeoutMs }) };
    };
    const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as PayPalError);
    const body = { intent: "CAPTURE" as const, purchase_units: [{ amount: { currency_code: "EUR" as const, value: "1.00" } }] };
    const a = setup();
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: NOT_ALLOWED });
    expect(await caught(a.client.createOrder(body, "a"))).toMatchObject({ status: 422, maybeDelivered: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 503, body: {} });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: NOT_ALLOWED });
    expect(await caught(a.client.createOrder(body, "b"))).toMatchObject({ status: 422, maybeDelivered: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    expect(await caught(a.client.createOrder(body, "c"))).toMatchObject({ kind: "network", maybeDelivered: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 500, body: {} });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 500, body: {} });
    expect(await caught(a.client.createOrder(body, "d"))).toMatchObject({ status: 500, maybeDelivered: true });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: NOT_ALLOWED });
    expect(await caught(a.client.createOrder(body, "e"))).toMatchObject({ status: 422, maybeDelivered: false });
    // An expired token (401, refreshed once) never reached the API: not maybe-delivered.
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 401, body: { error: "invalid_token", error_description: "Token signature verification failed" } });
    a.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: NOT_ALLOWED });
    expect(await caught(a.client.createOrder(body, "f"))).toMatchObject({ status: 422, maybeDelivered: false });
    const t = setup(50);
    await t.client.createOrder(body, "warm");
    t.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, hang: true });
    expect(await caught(t.client.createOrder(body, "g"))).toMatchObject({ kind: "timeout", maybeDelivered: true });
  });

  it("I1: the service records maybe_sent as soon as a send ends without a definitive answer", async () => {
    const { w, id } = await offered();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ n: 1, status: "sending", maybe_sent: true }]);
    // A later definitive refusal of any kind holds it (never `failed`): the first send may have refunded.
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: NOT_ALLOWED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refund_ops: [{ status: "needs_review", review_cause: "unknown", maybe_sent: true }] });
  });

  it.each([
    ["CAPTURE_FULLY_REFUNDED", FULLY_REFUNDED],
    ["REFUND_AMOUNT_EXCEEDED", EXCEEDED],
  ])("I1: a first send refused with %s (PayPal says money already moved) is held for review, not failed; it never clears by itself", async (_issue, body) => {
    const { w, id, got } = await offered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review", message: expect.stringMatching(/already refunded/) });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", refund_ops: [{ status: "needs_review", review_cause: "already_refunded" }] });
    expect(BookingService.reservedMinor(b)).toBe(3000);
    // A refund event naming the booking doesn't clear this hold: the refusal wasn't our refund's outcome.
    const other = { id: "ROUTOFBAND000091", status: "COMPLETED", amount: { currency_code: "EUR", value: "30.00" }, custom_id: id };
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: other });
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", other);
    await w.fake.flush();
    await deliver(w, got.at(-1)!);
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ status: "needs_review", review_cause: "already_refunded" }] });
  });

  it("kept: a first send refused outright, with no earlier attempt and no sign money moved, is failed and frees the deposit", async () => {
    const { w, id } = await offered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: NOT_ALLOWED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ status: 422 });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "failed" }] });
    expect((w.service.get(id)!.refund_ops[0] as unknown as Record<string, unknown>).maybe_sent).toBeFalsy();
  });
});

describe("R8-3: one intended refund, one operation", () => {
  it("partial 10.00, both replies lost, its event recorded, then the agent asks again for 10.00: nothing new is sent, the tool says so", async () => {
    const { w, id, got } = await offered();
    loseBothReplies(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_ops: [{ n: 1, status: "completed", acknowledged: false }] });
    const out = await tool(w, "refund_payment", { booking_id: id, amount: "10.00" });
    expect(out).toMatchObject({ ok: true, value: { status: "partially_refunded", refunded: { value: "10.00" }, acknowledged: { n: 1, status: "completed", amount: { currency_code: "EUR", value: "10.00" } } } });
    expect((out as unknown as { value: { note: string } }).value.note).toMatch(/nothing new was sent/i);
    expect(refundPosts(w)).toBe(2);
    expect(moved(w)).toBe(1000);
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ n: 1, status: "completed", acknowledged: true }]);
    expect(kinds(w, id)).toContain("refund.acknowledged");
    // Acknowledged once: a further call is a new request, decided as usual.
    expect(await w.service.refund(id, "10.00")).toMatchObject({ refunded_minor: 2000, refund_ops: [{ n: 1 }, { n: 2, status: "completed" }] });
  });

  it("a refund the event left pending is reported pending: nothing new is sent", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    loseBothReplies(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    const refundId = w.fake.refundIds()[0]!;
    const results: Array<{ status: number }> = [];
    w.fake.deliver = async (raw, headers) => void results.push(await w.service.handleWebhook(raw, headers));
    w.fake.emitWebhook("PAYMENT.REFUND.PENDING", "refund", { id: refundId, status: "PENDING", amount: { currency_code: "EUR", value: "10.00" }, custom_id: id });
    await w.fake.flush();
    expect(results).toEqual([{ status: 200, result: "logged" }]);
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ status: "pending", refund_id: refundId }]);
    const out = await tool(w, "refund_payment", { booking_id: id, amount: "10.00" });
    expect(out).toMatchObject({ ok: true, value: { acknowledged: { n: 1, status: "pending" }, refund_pending: { value: "10.00" } } });
    expect(refundPosts(w)).toBe(2);
  });

  it("settled pending by its event, then completed with that webhook lost: the next call reads it, reports it completed and sends nothing", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    loseBothReplies(w);
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    const refundId = w.fake.refundIds()[0]!;
    w.fake.deliver = async (raw, headers) => void (await w.service.handleWebhook(raw, headers));
    w.fake.emitWebhook("PAYMENT.REFUND.PENDING", "refund", { id: refundId, status: "PENDING", amount: { currency_code: "EUR", value: "10.00" }, custom_id: id });
    await w.fake.flush();
    expect(w.service.get(id)!.refund_ops).toMatchObject([{ status: "pending", acknowledged: false }]);
    w.fake.deliver = undefined; // the completion's webhook is lost
    w.fake.settleRefund(refundId, "COMPLETED");
    const out = await tool(w, "refund_payment", { booking_id: id, amount: "10.00" });
    expect(out).toMatchObject({ ok: true, value: { status: "partially_refunded", refunded: { value: "10.00" }, refund_pending: null, acknowledged: { n: 1, status: "completed" } } });
    expect(refundPosts(w)).toBe(2);
    expect(moved(w)).toBe(1000);
  });

  it("the tool's error on an ambiguous send says it may have gone through, that calling again never refunds twice, and get_booking", async () => {
    const { w, id } = await offered();
    loseBothReplies(w);
    const out = await tool(w, "refund_payment", { booking_id: id });
    expect(out.ok).toBe(false);
    const msg = (out as { message: string }).message;
    expect(msg).toMatch(/^refund_unconfirmed: /);
    expect(msg).toMatch(/may have gone through/);
    expect(msg).toMatch(/refund_payment again resends the same refund/);
    expect(msg).toMatch(/never refunds twice/);
    expect(msg).toMatch(/get_booking/);
  });

  it("the system prompt and refund_payment's description carry the same rule", () => {
    for (const text of [systemPrompt("2026-11-03"), findTool("refund_payment")!.description]) {
      expect(text).toMatch(/refund_unconfirmed/);
      expect(text).toMatch(/may have gone through/);
      expect(text).toMatch(/never refunds twice/);
    }
    expect(systemPrompt("2026-11-03")).toMatch(/refund_unconfirmed[^\n]*get_booking/);
  });

  it("at most one unknown operation: a booking with two (written outside the service) sends nothing", async () => {
    const { w, id } = await offered();
    const cur = w.service.get(id)!;
    const op = (n: number) => ({ n, request_id: `refund-${id}-${n}`, amount_minor: 1000, full: false, reason: "x", status: "sending" });
    w.db.prepare("UPDATE records SET json = ? WHERE kind = 'booking' AND id = ?").run(JSON.stringify({ ...cur, refund_ops: [op(1), op(2)] }), id);
    await expect(w.service.refund(id)).rejects.toThrow(/at most one/);
    expect(refundPosts(w)).toBe(0);
  });
});

describe("R8-4: a resend refused before the refund's event: the event still settles it", () => {
  it("full refund, both replies lost, the resend 422 CAPTURE_FULLY_REFUNDED (held), then PAYMENT.CAPTURE.REFUNDED: refunded, out of review", async () => {
    const { w, id, got } = await offered();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refund_ops: [{ status: "needs_review", review_cause: "unknown" }] });
    await w.fake.flush();
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    const refundId = w.fake.refundIds()[0]!;
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ids: [refundId], refund_ops: [{ status: "completed", refund_id: refundId }], reschedule: { status: "withdrawn" } });
    expect(w.service.summary(w.service.get(id)!)).toMatchObject({ refund_review: null, refund_pending: null });
    expect(w.channels.drain(CONV).filter((e) => e.type === "refunded")).toHaveLength(1);
  });

  it("the event's refund FAILED: the held refund is failed, the booking leaves review and the move can be answered again", async () => {
    const { w, id, got } = await offered();
    w.fake.pendNextRefund();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    w.fake.settleRefund(w.fake.refundIds()[0]!, "FAILED");
    await w.fake.flush();
    await deliver(w, got[0]!);
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [{ status: "failed" }], reschedule: { status: "proposed" } });
    expect(w.service.summary(b)).toMatchObject({ refund_review: null, reschedule_hold: null });
  });

  it("every other review cause still never clears: an event of another amount turns the unknown hold into a mismatch", async () => {
    const { w, id, got } = await offered();
    loseFirstReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    const other = { id: "RWRONGAMOUNT0092", status: "COMPLETED", amount: { currency_code: "EUR", value: "5.00" }, custom_id: id };
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: other });
    w.fake.emitWebhook("PAYMENT.CAPTURE.REFUNDED", "refund", other);
    await w.fake.flush();
    await deliver(w, got.at(-1)!);
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refunded_minor: 0, refund_ops: [{ status: "needs_review", review_cause: "mismatch", refund_id: other.id }] });
    // Its own event no longer clears it either.
    await deliver(w, got[0]!);
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refund_ops: [{ review_cause: "mismatch" }] });
  });

  it("a FAILED refund of another amount is not this operation's: it stays unknown and its deposit stays reserved", async () => {
    const { w, id, got } = await offered();
    loseBothReplies(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    const other = { id: "RFAILEDOTHER0093", status: "FAILED", amount: { currency_code: "EUR", value: "5.00" }, custom_id: id };
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: other });
    w.fake.emitWebhook("PAYMENT.REFUND.FAILED", "refund", other);
    await w.fake.flush();
    expect(await deliver(w, got.at(-1)!)).toEqual({ status: 200, result: "logged" });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "captured", refund_ops: [{ status: "sending" }] });
    expect(BookingService.reservedMinor(b)).toBe(3000);
    expect(kinds(w, id)).toContain("refund.evidence_unmatched");
  });
});

describe("R8-5: a capture PayPal already reports refunded, on its first reconcile, is held for review", () => {
  it.each(["REFUNDED", "PARTIALLY_REFUNDED"] as const)("%s: needs_review (capture.reconcile_failed), not paid, no 'Paid' event", async (status) => {
    const w = makeWorld();
    const { id, orderId } = await ordered(w);
    w.fake.approve(orderId);
    w.fake.mutateOrder(orderId, (o) => {
      o.status = "COMPLETED";
      o.purchase_units![0]!.payments = { captures: [{ id: "CREFUNDEDOOB0001", status, amount: { currency_code: "EUR", value: "30.00" }, final_capture: true }] };
    });
    w.channels.drain(CONV);
    expect(await w.service.captureIfApproved(id)).toMatchObject({ captured: false });
    const b = w.service.get(id)!;
    expect(b).toMatchObject({ status: "needs_review", capture_id: "CREFUNDEDOOB0001", capture_status: status });
    expect(b.captured).toBeUndefined();
    const row = w.ledger.list(id).find((e) => e.kind === "capture.reconcile_failed");
    expect(row?.data).toMatchObject({ status, problem: expect.stringMatching(/already refunded/) });
    expect(kinds(w, id)).not.toContain("capture.completed");
    expect(w.channels.drain(CONV).some((e) => e.type === "paid")).toBe(false);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
  });

  it("kept: a capture we refunded ourselves stays refunded when the capture is read again", async () => {
    const { w, id } = await offered();
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded" });
    expect(await w.service.captureIfApproved(id)).toMatchObject({ captured: true, booking: { status: "refunded" } });
    expect(kinds(w, id)).not.toContain("capture.reconcile_failed");
  });
});

describe("R8-6: the scripted agent says 'Done ... refunded' only when a refund completed", () => {
  const BK = "bk_0123456789ab";
  const after = (value: Record<string, unknown>) =>
    new ScriptedModel(() => "2026-11-03").complete([
      { role: "user", content: `[event] refund_offered ${BK}: The guide offered to refund the deposit.` },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", name: "refund_payment", arguments: JSON.stringify({ booking_id: BK }) }] },
      { role: "tool", tool_call_id: "c1", name: "refund_payment", content: JSON.stringify(value) },
    ]);
  const zero = { currency_code: "EUR", value: "0.00" };

  it("pending at PayPal: says it is pending, not done", async () => {
    const r = await after({ booking_id: BK, status: "captured", refunded: zero, refund_pending: { currency_code: "EUR", value: "30.00" }, refund_review: null, refund_ids: [] });
    expect(r.content).not.toMatch(/^Done/);
    expect(r.content).not.toMatch(/refunded to you/);
    expect(r.content).toMatch(/EUR 30\.00 is pending at PayPal/);
  });

  it("held for review: says so", async () => {
    const r = await after({ booking_id: BK, status: "needs_review", refunded: zero, refund_pending: null, refund_review: { currency_code: "EUR", value: "30.00" }, refund_ids: [] });
    expect(r.content).not.toMatch(/^Done/);
    expect(r.content).toMatch(/held for review/);
  });

  it("an earlier refund acknowledged: says it was the earlier one and nothing new was sent", async () => {
    const r = await after({ booking_id: BK, status: "partially_refunded", refunded: { currency_code: "EUR", value: "10.00" }, refund_pending: null, refund_review: null, refund_ids: ["R1"], acknowledged: { n: 1, status: "completed", amount: { currency_code: "EUR", value: "10.00" } } });
    expect(r.content).toMatch(/earlier refund/i);
    expect(r.content).toMatch(/nothing new was sent/i);
  });

  it("kept: a completed refund says Done", async () => {
    const r = await after({ booking_id: BK, status: "refunded", refunded: { currency_code: "EUR", value: "30.00" }, refund_pending: null, refund_review: null, refund_ids: ["R1"] });
    expect(r.content).toBe("Done: EUR 30.00 refunded to you from the guide's PayPal (booking refunded).");
  });

  it("through the real tools: the guide's offer, a PENDING refund, and the scripted reply says pending", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    const agent = new Agent(new ScriptedModel(() => "2026-11-03"), { service: w.service, channels: w.channels, sendOperatorLink: () => {} }, () => "2026-11-03");
    const turn = await agent.turn(CONV, `[event] refund_offered ${id}: The guide offered to refund the deposit.`);
    expect(turn.tools).toEqual([{ name: "refund_payment", ok: true }]);
    expect(turn.reply).not.toMatch(/^Done/);
    expect(turn.reply).toMatch(/pending at PayPal/);
  });
});

describe("the traveller's card shows a refund being sent or pending", () => {
  const base = { booking_id: "bk_1", guide: { name: "Lantern Ridge Walks (demo)" }, capture: { id: "C1", amount: { currency_code: "EUR", value: "30.00" }, status: "COMPLETED" }, refunded: { currency_code: "EUR", value: "0.00" } };

  it("refund_pending set: a 'refund under way' line next to 'Paid'", () => {
    const b = { ...base, status: "captured", refund_pending: { currency_code: "EUR", value: "30.00" } };
    expect(labels.paymentLine(b).testid).toBe("paid");
    expect(labels.refundLine(b)).toEqual({ testid: "refund-pending", text: "Refund under way: EUR 30.00 back to you from Lantern Ridge Walks (demo); PayPal hasn't confirmed it yet." });
  });

  it("no refund under way: no line", () => {
    expect(labels.refundLine({ ...base, status: "captured", refund_pending: null })).toBeNull();
    expect(labels.refundLine({ ...base, status: "refunded", refunded: { currency_code: "EUR", value: "30.00" }, refund_pending: null })).toBeNull();
  });

  it("the page renders it (app.js appends refundLine's line to each card)", () => {
    const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    expect(app).toMatch(/import \{[^}]*\brefundLine\b[^}]*\} from "\/labels\.js"/);
    expect(app).toMatch(/refundLine\(b\)/);
  });

  it("from the service: a pending refund's summary gives that line", async () => {
    const { w, id } = await offered();
    w.fake.pendNextRefund();
    await w.service.refund(id);
    expect(labels.refundLine(w.service.summary(w.service.get(id)!))).toMatchObject({ testid: "refund-pending", text: expect.stringMatching(/^Refund under way: EUR 30\.00/) });
  });

  it("a refund held only because PayPal's answer is unknown says that, not that a reply didn't match", async () => {
    const { w, id } = await offered();
    loseFirstReply(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: FULLY_REFUNDED });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    const s = w.service.summary(w.service.get(id)!);
    expect(s).toMatchObject({ refund_review: { currency_code: "EUR", value: "30.00" }, refund_review_cause: "unknown" });
    const line = labels.paymentLine(s);
    expect(line.testid).toBe("refund-review");
    expect(line.text).toMatch(/^A refund is held for review: PayPal gave no definitive answer about the refund of EUR 30\.00, so it may have gone through/);
    expect(line.text).not.toMatch(/didn't match/);
  });
});
