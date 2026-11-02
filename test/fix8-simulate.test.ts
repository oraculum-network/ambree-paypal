// Round 8, D2: the demo's simulated warning (once per booking) isn't spent on a booking that can't be
// moved. §14 gates it on `captured` because only a captured booking can be moved; since round 7 (S2) a
// captured booking with a refund under way (sent and unanswered, or pending at PayPal) can't be moved
// either, so the simulation refuses it too, and the page's control says why.

import { describe, expect, it } from "vitest";
import { CONV, type World, kinds, paid } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";

const pendingRefund = (w: World) =>
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000081", status: "PENDING", amount: { currency_code: "EUR", value: "30.00" } } });

/** Nothing of a simulation is on the booking, in its ledger or in the agent's events. */
function nothingSimulated(w: World, id: string) {
  expect(w.service.get(id)!.simulated_alert).toBeUndefined();
  expect(kinds(w, id)).not.toContain("weather.simulated_alert");
  expect(w.channels.drain(CONV).filter((e) => e.type === "cyclone")).toEqual([]);
}

describe("D2: no simulated warning while a refund of the deposit is under way", () => {
  it("a refund pending at PayPal: refused (cannot_simulate, it says why), nothing saved, logged or announced", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    pendingRefund(w);
    expect(await w.service.refund(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "pending" }] });
    w.channels.drain(CONV);
    await expect(w.service.simulateCyclone(id)).rejects.toMatchObject({ code: "cannot_simulate", message: expect.stringMatching(/refund of the deposit has started/) });
    nothingSimulated(w, id);
    // The refund fails at PayPal: the booking can be moved again, and the warning is still there to post.
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000081", status: "FAILED", amount: { currency_code: "EUR", value: "30.00" } } });
    expect(await w.service.refreshRefunds(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "failed" }] });
    expect(await w.service.simulateCyclone(id)).toMatchObject({ posted: true });
    expect(kinds(w, id).filter((k) => k === "weather.simulated_alert")).toHaveLength(1);
  });

  it("a refund whose reply was lost (still being sent): refused too", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    expect(w.service.get(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "sending" }] });
    w.channels.drain(CONV);
    await expect(w.service.simulateCyclone(id)).rejects.toMatchObject({ code: "cannot_simulate" });
    nothingSimulated(w, id);
  });

  it("kept: a captured booking with no refund, or only a failed one, takes it", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED", description: "refused" }] } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ status: 422 });
    expect(await w.service.simulateCyclone(id)).toMatchObject({ posted: true });
  });
});

describe("D2: the page's control is off while a refund is under way, and says why", () => {
  const b = (status: string, refund_pending: unknown = null) => ({ booking_id: "bk_000000000001", status, refund_pending });

  it("sandbox: captured with a refund pending or being sent disables it with the reason", () => {
    const v = labels.simulateControl("sandbox", [b("captured", { currency_code: "EUR", value: "30.00" })]);
    expect(v).toMatchObject({ disabled: true });
    expect(v.hint).toMatch(/can't simulate now/i);
    expect(v.hint).toMatch(/refund of the deposit has started/);
  });

  it("kept: captured with no refund under way is enabled; fake mode is unchanged", () => {
    expect(labels.simulateControl("sandbox", [b("captured")])).toEqual({ disabled: false, hint: "" });
    expect(labels.simulateControl("fake", [b("captured", { currency_code: "EUR", value: "30.00" })])).toEqual({ disabled: false, hint: "" });
  });
});
