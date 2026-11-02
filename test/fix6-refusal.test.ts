// Round 6, R2: a refused refund added "A simulated cyclone warning (demo) doesn't allow a refund by
// itself: …" whenever the booking had a simulated warning, even once the guide had declined and the deposit
// was refunded. The suffix now shows only when the simulated warning is the only would-be reason (a paid,
// not fully refunded booking the warning covers, with no offer and no declined move), and a refunded
// booking is told the deposit was already refunded.

import { describe, expect, it } from "vitest";
import { type Booking, type BookingStatus, ServiceError } from "../src/booking/service.ts";
import { Records } from "../src/store/db.ts";
import { DATE, type World, paid, requested } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const SUFFIX = /simulated cyclone warning \(demo\) doesn't allow a refund by itself/;

async function refusal(w: World, id: string): Promise<ServiceError> {
  try {
    await w.service.refund(id);
  } catch (e) {
    if (e instanceof ServiceError) return e;
    throw e;
  }
  throw new Error("the refund was allowed");
}

async function simulatedAndPaid() {
  const w = makeWorld();
  const r = await paid(w);
  expect((await w.service.simulateCyclone(r.id)).posted).toBe(true);
  return { w, ...r };
}

describe("R2: the simulated-warning note only when that warning is the only would-be reason", () => {
  it("captured, simulated, nothing else: refused with the note", async () => {
    const { w, id } = await simulatedAndPaid();
    const e = await refusal(w, id);
    expect(e.code).toBe("refund_not_allowed");
    expect(e.message).toMatch(/needs a cyclone warning \(orange or red\) on the date, a declined reschedule, or the guide's offer/);
    expect(e.message).toMatch(SUFFIX);
  });

  it("partially refunded, simulated, and the real warning gone: still the note", async () => {
    const { w, id } = await simulatedAndPaid();
    w.weather.raise({ id: "TC-R2", name: "Cyclone R2", level: "orange", from: DATE, to: DATE, summary: "" });
    expect((await w.service.refund(id, "10.00")).status).toBe("partially_refunded");
    w.weather.clear();
    expect((await refusal(w, id)).message).toMatch(SUFFIX);
  });

  it("simulated → the guide declines the move → refunded: asking again says the deposit was already refunded, with no note", async () => {
    const { w, id, token } = await simulatedAndPaid();
    await w.service.proposeReschedule(id, "2026-11-08");
    await w.service.answerReschedule(token, false);
    expect((await w.service.refund(id)).status).toBe("refunded");
    const e = await refusal(w, id);
    expect(e.code).toBe("refund_not_allowed");
    expect(e.message).toMatch(/deposit was already refunded/);
    expect(e.message).not.toMatch(SUFFIX);
    expect(e.message).not.toMatch(/needs a cyclone warning/);
  });

  it("a refunded booking that never had a simulated warning says the same", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    expect((await w.service.refund(id)).status).toBe("refunded");
    expect((await refusal(w, id)).message).toMatch(/deposit was already refunded/);
  });

  it("simulated → the guide accepts the move: the warning doesn't cover the new day, so no note", async () => {
    const { w, id, token } = await simulatedAndPaid();
    await w.service.proposeReschedule(id, "2026-11-08");
    await w.service.answerReschedule(token, true);
    const e = await refusal(w, id);
    expect(e.message).toMatch(/needs a cyclone warning/);
    expect(e.message).not.toMatch(SUFFIX);
  });

  it.each<BookingStatus>(["needs_review", "capture_pending", "priced"])("a %s booking with a simulated warning on it: no note, and the refusal says the booking isn't refundable", async (status) => {
    const { w, id } = await simulatedAndPaid();
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, status });
    const e = await refusal(w, id);
    expect(e.message).not.toMatch(SUFFIX);
    expect(e.message).toContain(`it is ${status}`);
  });

  it("an unpaid booking's refusal names its status too", async () => {
    const w = makeWorld();
    const { id } = requested(w);
    expect((await refusal(w, id)).message).toMatch(/isn't paid yet \(it is requested\), so there is nothing to refund/);
  });
});
