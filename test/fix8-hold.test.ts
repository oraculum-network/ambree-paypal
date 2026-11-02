// Round 8, D4: a proposed move the guide can't answer says so. The guide can answer only while the booking
// is captured and no refund has started (rescheduleAnswerable). While a refund is being sent or pending,
// or the booking is held for review (which never clears by itself), a proposed move stays `proposed`, so
// get_booking (and the traveller's card) also say what it waits on instead: `reschedule_hold`.

import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/loop.ts";
import { findTool, runTool } from "../src/tools/registry.ts";
import { CONV, type World, paid } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";

const MOVED = "2026-11-08";
const REVIEW = "the booking is held for review";
const UNDER_WAY = "a refund of the deposit is under way";

const getBooking = async (w: World, id: string) => {
  const out = await runTool("get_booking", { booking_id: id }, { service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
  if (!out.ok) throw new Error(out.message);
  return out.value;
};

/** Paid, a move proposed to the guide, and the guide's refund offer. */
async function proposedAndOffered() {
  const w = makeWorld();
  const { id, token } = await paid(w);
  await w.service.proposeReschedule(id, MOVED);
  await w.service.offerRefund(token);
  return { w, id, token };
}

describe("D4: get_booking says when the guide can't answer a proposed move, and why", () => {
  it("held for review (a refund reply that didn't match): proposed, and on hold for the review", async () => {
    const { w, id } = await proposedAndOffered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RBAD000000000081", status: "COMPLETED", amount: { currency_code: "EUR", value: "0.01" } } });
    expect(await w.service.refund(id)).toMatchObject({ status: "needs_review", reschedule: { status: "proposed" } });
    const s = await getBooking(w, id);
    expect(s).toMatchObject({ status: "needs_review", reschedule: { new_date: MOVED, status: "proposed" }, reschedule_hold: REVIEW });
    // The traveller's card says so too, rather than a bare "proposed".
    expect(labels.rescheduleLine(s)).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: proposed, but the guide can't answer it while ${REVIEW}.` });
  });

  it("a refund pending at PayPal: on hold while it is; once it fails, the guide can answer again", async () => {
    const { w, id } = await proposedAndOffered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000082", status: "PENDING", amount: { currency_code: "EUR", value: "30.00" } } });
    expect(await w.service.refund(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "pending" }] });
    expect(await getBooking(w, id)).toMatchObject({ reschedule: { status: "proposed" }, reschedule_hold: UNDER_WAY });
    expect(labels.rescheduleLine(await getBooking(w, id)).text).toBe(`Reschedule to ${MOVED}: proposed, but the guide can't answer it while ${UNDER_WAY}.`);
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000082", status: "FAILED", amount: { currency_code: "EUR", value: "30.00" } } });
    await w.service.refreshRefunds(id);
    const s = await getBooking(w, id);
    expect(s).toMatchObject({ status: "captured", reschedule: { status: "proposed" }, reschedule_hold: null });
    expect(labels.rescheduleLine(s).text).toBe(`Reschedule to ${MOVED}: proposed`);
  });

  it("a refund whose reply was lost (still being sent): on hold too", async () => {
    const { w, id } = await proposedAndOffered();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    expect(await getBooking(w, id)).toMatchObject({ reschedule: { status: "proposed" }, reschedule_hold: UNDER_WAY });
  });

  it("kept: a move the guide can answer, an answered one and no move at all have no hold", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    expect(await getBooking(w, id)).toMatchObject({ reschedule: null, reschedule_hold: null });
    await w.service.proposeReschedule(id, MOVED);
    expect(await getBooking(w, id)).toMatchObject({ reschedule: { status: "proposed" }, reschedule_hold: null });
    await w.service.answerReschedule(token, true);
    expect(await getBooking(w, id)).toMatchObject({ reschedule: { status: "accepted" }, reschedule_hold: null });
  });
});

describe("D4: the model is told `proposed` is answerable only while nothing holds it", () => {
  it("get_booking's description and the system prompt name reschedule_hold, not just 'waiting for the guide'", () => {
    for (const text of [findTool("get_booking")!.description, systemPrompt("2026-11-03")]) {
      expect(text).toMatch(/reschedule_hold/);
      expect(text).not.toMatch(/proposed \(waiting for the guide\)/);
      expect(text).toMatch(/proposed \([^)]*captured[^)]*no refund has started/);
    }
  });

  it("refund_payment's description says a pending or in-review refund puts a waiting move on hold", () => {
    expect(findTool("refund_payment")!.description).toMatch(/pending or held for review[^.]*reschedule_hold/);
  });
});
