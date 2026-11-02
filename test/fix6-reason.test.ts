// Round 6, R1: refund() looked the weather up for the booking's date, then reserved and sent the refund with
// that reason on the booking as re-read after the lookup, even when the reason no longer held on it (the
// guide accepted a move to a day no warning covers while the feed was answering). The reason is now derived
// again on the fresh booking: its status, the guide's offer and a declined move first; a feed warning counts
// only for the date that was looked up (a moved date is looked up once more; a second move is refused with
// a retryable error).
// Since round 7 no step of the service can change the booking while the refund waits on the feed: the
// guide's answer queues behind the refund (fix7-serial). These tests now change the booking straight in the
// store during the lookup, as another process on the same file would, so the re-read stays covered.

import { describe, expect, it } from "vitest";
import { type Booking, ServiceError } from "../src/booking/service.ts";
import { Records } from "../src/store/db.ts";
import type { CycloneFeed, DemoCycloneFeed } from "../src/weather/cyclones.ts";
import { DATE, type Gate, type World, gate, kinds, paid, refundPosts } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const MOVED_AGAIN = "2026-11-11";

/** A world whose feed lookups are recorded, and held by each gate in turn while it is armed. */
function world(...gates: Gate[]): { w: World; looked: string[] } {
  const looked: string[] = [];
  const w = makeWorld({
    weather: (feed: DemoCycloneFeed): CycloneFeed => ({
      alertsFor: (d) => {
        looked.push(d);
        let call = () => feed.alertsFor(d);
        for (const g of [...gates].reverse()) {
          const inner = call;
          call = () => g.pass(inner);
        }
        return call();
      },
    }),
  });
  return { w, looked };
}

/** Changes the booking in the store, outside the service and its queue. */
function outside(w: World, id: string, patch: Partial<Booking>) {
  const records = new Records<Booking>(w.db, "booking");
  records.put({ ...records.get(id)!, ...patch });
}
const accepted = (to: string): Partial<Booking> => ({ date: to, reschedule: { new_date: to, status: "accepted" } });

const alert = (w: World, to: string) => w.weather.raise({ id: `TC-R1-${to}`, name: "Cyclone R1", level: "orange", from: DATE, to, summary: "" });
const refundRows = (w: World, id: string) => kinds(w, id).filter((k) => k.startsWith("refund."));

describe("R1: the refund's reason is derived again on the booking as it is after the feed answered", () => {
  it("the date moves to a day no warning covers while the feed answers: no refund goes out", async () => {
    const g = gate();
    const { w, looked } = world(g);
    const { id } = await paid(w);
    alert(w, DATE); // a real orange warning on 11-05 only
    await w.service.proposeReschedule(id, MOVED);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered; // the feed said 11-05 is covered; nothing is reserved yet
    outside(w, id, accepted(MOVED));
    g.release();
    await expect(refunding).rejects.toMatchObject({ code: "refund_not_allowed" });
    expect(refundPosts(w)).toBe(0);
    expect(refundRows(w, id)).toEqual([]);
    expect(w.service.get(id)).toMatchObject({ status: "captured", date: MOVED, refunded_minor: 0, refund_ops: [], reschedule: { status: "accepted" } });
    expect(looked).toEqual([DATE, MOVED]);
  });

  it("a warning that also covers the new day: the new day is looked up and the refund goes out for it", async () => {
    const g = gate();
    const { w, looked } = world(g);
    const { id } = await paid(w);
    alert(w, MOVED); // covers 11-05 to 11-08
    await w.service.proposeReschedule(id, MOVED);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered;
    outside(w, id, accepted(MOVED));
    g.release();
    expect(await refunding).toMatchObject({ status: "refunded", date: MOVED });
    expect(looked).toEqual([DATE, MOVED]);
    expect(w.ledger.list(id).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "a cyclone warning covers the date" });
    expect(refundPosts(w)).toBe(1);
  });

  it("the date moves again during the second lookup: refused with a retryable error, then a retry decides on the date as it is", async () => {
    const first = gate();
    const second = gate();
    const { w, looked } = world(first, second);
    const { id } = await paid(w);
    alert(w, MOVED_AGAIN); // covers 11-05 to 11-11
    await w.service.proposeReschedule(id, MOVED);
    first.arm();
    const refunding = w.service.refund(id);
    await first.entered;
    outside(w, id, accepted(MOVED));
    second.arm();
    first.release();
    // The lookup for 11-08 (fails fast, rather than timing out, if the refund settles without it).
    const next = await Promise.race([second.entered.then(() => "looked up again"), refunding.then(() => "refunded", () => "refused")]);
    expect(next).toBe("looked up again");
    outside(w, id, accepted(MOVED_AGAIN));
    second.release();
    const e = await refunding.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe("date_changed");
    expect((e as ServiceError).message).toMatch(/date changed .*again/i);
    expect(refundPosts(w)).toBe(0);
    expect(refundRows(w, id)).toEqual([]);
    expect(looked).toEqual([DATE, MOVED]);
    // Nothing was reserved, so asking again decides on 11-11 (which the warning covers).
    expect((await w.service.refund(id)).status).toBe("refunded");
    expect(looked).toEqual([DATE, MOVED, MOVED_AGAIN]);
  });

  it("the move is declined while the feed answers: the refund reads the decline", async () => {
    const g = gate();
    const { w } = world(g);
    const { id } = await paid(w);
    alert(w, DATE);
    await w.service.proposeReschedule(id, MOVED);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered;
    outside(w, id, { reschedule: { new_date: MOVED, status: "declined" } });
    g.release();
    expect((await refunding).status).toBe("refunded");
    expect(w.ledger.list(id).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "the guide declined the reschedule" });
  });

  it("the booking stops being refundable while the feed answers: no refund goes out", async () => {
    const g = gate();
    const { w } = world(g);
    const { id } = await paid(w);
    alert(w, DATE);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered;
    // Written straight to the store (as a reconcile by another process would): the booking is now held.
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, status: "needs_review" });
    g.release();
    await expect(refunding).rejects.toBeInstanceOf(ServiceError);
    expect(refundPosts(w)).toBe(0);
    expect(refundRows(w, id)).toEqual([]);
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", refund_ops: [] });
  });

  it("no race: the same reasons as before, and the guide's offer or decline needs no feed lookup", async () => {
    const { w, looked } = world();
    const { id, token } = await paid(w);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
    expect(looked).toEqual([DATE]);
    await w.service.offerRefund(token);
    expect((await w.service.refund(id, "10.00")).status).toBe("partially_refunded");
    expect(looked).toEqual([DATE]);
    expect(w.ledger.list(id).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "the guide offered it" });
  });
});
