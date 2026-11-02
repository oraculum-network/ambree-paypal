// Round 8, D5: the traveller's card after a partial refund withdrew the move and the next refund's reply
// didn't match. The withdrawn reason follows what was refunded (not the status, which is now
// needs_review), and a refund under review gets its own line instead of the capture's "did not match the
// approved mandate" (the capture matched; a refund reply didn't).

import { describe, expect, it } from "vitest";
import { DATE, type World, paid } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";

const MOVED = "2026-11-08";
const realAlert = (w: World) => w.weather.raise({ id: "TC-R8", name: "Cyclone R8", level: "orange", from: DATE, to: DATE, summary: "" });

describe("D5: a partial refund withdrew the move, then the next refund's reply didn't match", () => {
  async function scenario() {
    const w = makeWorld();
    const { id } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded", reschedule: { status: "withdrawn" } });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RBAD000000000085", status: "COMPLETED", amount: { currency_code: "EUR", value: "19.99" } } });
    expect(await w.service.refund(id)).toMatchObject({ status: "needs_review", refunded_minor: 1000 });
    return w.service.summary(w.service.get(id)!);
  }

  it("the card says part of the deposit was refunded (10.00 of 30.00), not the deposit", async () => {
    const s = await scenario();
    expect(labels.rescheduleLine(s)).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: withdrawn, because part of the deposit was refunded.` });
  });

  it("the payment line says a refund needs review, and the deposit was paid; not that the capture mismatched", async () => {
    const s = await scenario();
    expect(s.refund_review).toEqual({ currency_code: "EUR", value: "20.00" });
    const line = labels.paymentLine(s);
    expect(line.testid).toBe("refund-review");
    expect(line.text).toMatch(/^A refund needs review: PayPal's reply about the refund of EUR 20\.00 didn't match what was sent/);
    expect(line.text).toMatch(/EUR 30\.00 to Lantern Ridge Walks \(demo\), was paid/);
    expect(line.text).not.toMatch(/approved mandate/);
  });
});

describe("D5: the withdrawn reason follows the amounts", () => {
  const card = (status: string, refunded: string) =>
    labels.rescheduleLine({ status, capture: { id: "C1", amount: { currency_code: "EUR", value: "30.00" } }, refunded: { currency_code: "EUR", value: refunded }, reschedule: { new_date: MOVED, status: "withdrawn" } }).text;

  it("all of the deposit: the deposit was refunded, whatever the status", () => {
    expect(card("refunded", "30.00")).toBe(`Reschedule to ${MOVED}: withdrawn, because the deposit was refunded.`);
    expect(card("needs_review", "30.00")).toBe(`Reschedule to ${MOVED}: withdrawn, because the deposit was refunded.`);
  });

  it("part of it: part of the deposit was refunded, whatever the status", () => {
    expect(card("partially_refunded", "10.00")).toBe(`Reschedule to ${MOVED}: withdrawn, because part of the deposit was refunded.`);
    expect(card("needs_review", "10.00")).toBe(`Reschedule to ${MOVED}: withdrawn, because part of the deposit was refunded.`);
  });
});

describe("D5: kept", () => {
  it("a capture that didn't match the mandate still says so", () => {
    const line = labels.paymentLine({ status: "needs_review", guide: { name: "G" }, capture: { id: "C1", amount: null, status: "COMPLETED" }, refund_review: null });
    expect(line.testid).toBe("payment-review");
    expect(line.text).toMatch(/approved mandate/);
  });
});
