// Round 6, R4: when a booking became fully refunded, a move still waiting for the guide (reschedule
// `proposed`) stayed "proposed" on the traveller's card, although the guide's page no longer asks. It is now
// closed in the same save as the refund: reschedule status `withdrawn`, a `reschedule.withdrawn` ledger row,
// and the card says it was withdrawn because the deposit was refunded. The status is additive, so records
// written before it still load (SCHEMA_VERSION stays 2).

import { describe, expect, it } from "vitest";
import { type Booking, ServiceError } from "../src/booking/service.ts";
import { renderOperatorPage } from "../src/operator/page.ts";
import { Records, SCHEMA_VERSION } from "../src/store/db.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";
import { DATE, type World, kinds, paid } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const WITHDRAWN = "reschedule.withdrawn";
const realAlert = (w: World) => w.weather.raise({ id: "TC-R4", name: "Cyclone R4", level: "orange", from: DATE, to: DATE, summary: "" });

async function proposed() {
  const w = makeWorld();
  const r = await paid(w);
  w.service.proposeReschedule(r.id, MOVED);
  return { w, ...r };
}

describe("R4: a full refund withdraws a move still waiting for the guide", () => {
  it("the guide offers a refund instead of answering: refunded, the move withdrawn and logged after the refund", async () => {
    const { w, id, token } = await proposed();
    w.service.offerRefund(token);
    const b = await w.service.refund(id);
    expect(b).toMatchObject({ status: "refunded", date: DATE, reschedule: { new_date: MOVED, status: "withdrawn" } });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", reschedule: { new_date: MOVED, status: "withdrawn" } });
    const k = kinds(w, id);
    expect(k.filter((x) => x === WITHDRAWN)).toHaveLength(1);
    expect(k.indexOf("refund.completed")).toBeLessThan(k.indexOf(WITHDRAWN));
    expect(w.ledger.list(id).find((e) => e.kind === WITHDRAWN)!.data).toEqual({ from: DATE, to: MOVED, reason: "the deposit was refunded" });
    expect(w.service.summary(b).reschedule).toEqual({ new_date: MOVED, status: "withdrawn" });
    expect(w.ledger.verify().ok).toBe(true);
    // Nothing is waiting any more: the guide's page doesn't ask and an answer is refused.
    expect(renderOperatorPage(token, b)).not.toContain("Move the trip?");
    expect(() => w.service.answerReschedule(token, true)).toThrow(ServiceError);
    expect(w.service.get(id)!.date).toBe(DATE);
  });

  it("a refund that completes later (PENDING, then COMPLETED by GET after the webhook) withdraws it too", async () => {
    const { w, id } = await proposed();
    realAlert(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000064", status: "PENDING", amount: { currency_code: "EUR", value: "30.00" } } });
    expect(await w.service.refund(id)).toMatchObject({ status: "captured", reschedule: { status: "proposed" } });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000064", status: "COMPLETED", amount: { currency_code: "EUR", value: "30.00" } } });
    expect(await w.service.refreshRefunds(id)).toMatchObject({ status: "refunded", reschedule: { new_date: MOVED, status: "withdrawn" } });
    expect(kinds(w, id).filter((x) => x === WITHDRAWN)).toHaveLength(1);
  });

  it("a partial refund leaves it proposed; the refund that completes the deposit withdraws it", async () => {
    const { w, id } = await proposed();
    realAlert(w);
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded", reschedule: { status: "proposed" } });
    expect(kinds(w, id)).not.toContain(WITHDRAWN);
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded", reschedule: { status: "withdrawn" } });
    expect(kinds(w, id).filter((x) => x === WITHDRAWN)).toHaveLength(1);
  });

  it("an answered move (declined or accepted) is left as it was", async () => {
    const declined = await proposed();
    declined.w.service.answerReschedule(declined.token, false);
    expect(await declined.w.service.refund(declined.id)).toMatchObject({ status: "refunded", reschedule: { new_date: MOVED, status: "declined" } });
    expect(kinds(declined.w, declined.id)).not.toContain(WITHDRAWN);

    const accepted = await proposed();
    accepted.w.service.answerReschedule(accepted.token, true);
    accepted.w.service.offerRefund(accepted.token);
    expect(await accepted.w.service.refund(accepted.id)).toMatchObject({ status: "refunded", date: MOVED, reschedule: { new_date: MOVED, status: "accepted" } });
    expect(kinds(accepted.w, accepted.id)).not.toContain(WITHDRAWN);
  });

  it("kept: a simulated warning, then the guide's decline and the refund: simulating again answers posted:false", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    expect((await w.service.simulateCyclone(id)).posted).toBe(true);
    w.service.proposeReschedule(id, MOVED);
    w.service.answerReschedule(token, false);
    expect((await w.service.refund(id)).status).toBe("refunded");
    expect(await w.service.simulateCyclone(id)).toMatchObject({ posted: false, booking: { status: "refunded" } });
  });

  it("records written before the status existed still load: the schema version is unchanged", async () => {
    expect(SCHEMA_VERSION).toBe(2);
    const w = makeWorld();
    const { id, token } = await paid(w);
    const records = new Records<Booking>(w.db, "booking");
    // As an older build left it: refunded, with the move still "proposed".
    records.put({ ...records.get(id)!, status: "refunded", reschedule: { new_date: MOVED, status: "proposed" } });
    expect(w.service.summary(w.service.get(id)!).reschedule).toEqual({ new_date: MOVED, status: "proposed" });
    expect(renderOperatorPage(token, w.service.get(id)!)).not.toContain("Move the trip?");
  });
});

describe("R4: the traveller's card says why the move was withdrawn", () => {
  const card = (status: string) => labels.rescheduleLine?.({ reschedule: { new_date: MOVED, status } });

  it("withdrawn: because the deposit was refunded", () => {
    expect(card("withdrawn")).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: withdrawn, because the deposit was refunded.` });
  });

  it("the other statuses read as before, and no reschedule shows nothing", () => {
    for (const s of ["proposed", "accepted", "declined"]) expect(card(s)).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: ${s}` });
    expect(labels.rescheduleLine?.({ reschedule: null })).toBeNull();
  });
});
