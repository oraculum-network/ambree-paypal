// Round 6, R3: a full refund still being sent (or pending at PayPal) left the booking `captured`, so the
// guide could still accept the move mid-refund and the booking ended refunded and rescheduled. Once any
// refund operation is under way (any status but `failed`: money has started coming back), the move can't
// be answered and the guide's page no longer asks. A refund PayPal refused (`failed`) blocks nothing.

import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/booking/service.ts";
import { applyOperatorAction, renderOperatorPage } from "../src/operator/page.ts";
import { DATE, type World, gate, kinds, later, paid, slow } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const QUESTION = "Move the trip?";

const answers = (w: World, id: string) => kinds(w, id).filter((k) => k === "reschedule.accepted" || k === "reschedule.declined");
const realAlert = (w: World) => w.weather.raise({ id: "TC-R3", name: "Cyclone R3", level: "orange", from: DATE, to: DATE, summary: "" });

async function expectNoAnswer(w: World, id: string, token: string) {
  for (const accept of [true, false]) {
    let e: unknown;
    try {
      await w.service.answerReschedule(token, accept);
    } catch (x) {
      e = x;
    }
    expect(e, `accept=${accept}`).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe("wrong_state");
    expect((e as ServiceError).message).toMatch(/refund/);
  }
  expect(renderOperatorPage(token, w.service.get(id)!)).not.toContain(QUESTION);
  expect((await applyOperatorAction(w.service, token, new URLSearchParams({ action: "accept_reschedule" }))).ok).toBe(false);
  expect((await applyOperatorAction(w.service, token, new URLSearchParams({ action: "decline_reschedule" }))).ok).toBe(false);
  expect(w.service.get(id)!.date).toBe(DATE);
  expect(answers(w, id)).toEqual([]);
}

describe("R3: no answer to a move once a refund is under way", () => {
  it("a full refund whose POST is in flight: the move can't be accepted, and the booking ends refunded on its own date", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, MOVED);
    await w.service.offerRefund(token);
    expect(renderOperatorPage(token, w.service.get(id)!)).toContain(QUESTION);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered; // PayPal refunded; the operation is still `sending` and the booking `captured`
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "sending", full: true }] });
    await expectNoAnswer(w, id, token);
    g.release();
    expect(await refunding).toMatchObject({ status: "refunded", date: DATE });
    expect(answers(w, id)).toEqual([]);
  });

  it("a partial refund pending at PayPal: the move can't be answered either", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000061", status: "PENDING", amount: { currency_code: "EUR", value: "10.00" } } });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "captured", refund_ops: [{ status: "pending" }] });
    await expectNoAnswer(w, id, token);
  });

  it("a refund PayPal refused (failed) blocks nothing: the page asks and the guide can move the trip", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED", description: "refused" }] } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ status: 422 });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "failed" }] });
    expect(renderOperatorPage(token, w.service.get(id)!)).toContain(QUESTION);
    expect(await w.service.answerReschedule(token, true)).toMatchObject({ date: MOVED, reschedule: { status: "accepted" } });
  });

  it("kept: a partially refunded booking can't answer a move (as proposeReschedule refuses one)", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    expect((await w.service.refund(id, "10.00")).status).toBe("partially_refunded");
    await expect(later(() => w.service.answerReschedule(token, true))).rejects.toThrow(ServiceError);
    expect(renderOperatorPage(token, w.service.get(id)!)).not.toContain(QUESTION);
    expect(w.service.get(id)!.date).toBe(DATE);
  });
});
