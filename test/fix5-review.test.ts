// Round 5: the review of the hosted cyclone simulation (7c9ba15..05c5037).
// F1 the simulation is accepted only on a captured booking, and the page says so;
// F2 no save after an await may wipe a change made meanwhile (capture, refund refresh, refund request),
//    and the simulation runs one at a time with the booking's money steps;
// F3 a simulated warning never unlocks a refund by itself, and a reschedule can be answered only on a
//    captured booking;
// F4 the JSON media type is matched case-insensitively everywhere;
// F5 each refused simulation says accurately why.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Booking, type BookingStatus, ServiceError } from "../src/booking/service.ts";
import { applyOperatorAction, renderOperatorPage } from "../src/operator/page.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_WEBHOOK_ID, FakePayPal } from "../src/paypal/fake.ts";
import { Records } from "../src/store/db.ts";
import type { CycloneAlert } from "../src/weather/cyclones.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";
import { Browser, startApp } from "./helpers/server.ts";
import { makeWorld, tokenOf } from "./helpers/world.ts";

type World = ReturnType<typeof makeWorld>;
type State = Record<string, any>;

const CONV = "cv_review5_00000001";
const DATE = "2026-11-05";
const SIMULATED_KIND = "weather.simulated_alert";
const NOT_PAID: BookingStatus[] = ["requested", "priced", "mandate_proposed", "mandate_approved", "order_created"];
/** Finished or still in processing, each with what the refusal must say about why. */
const NOT_NOW: Array<[BookingStatus, RegExp]> = [
  ["declined", /declined/],
  ["capture_pending", /pending|processing/],
  ["capture_failed", /failed/],
  ["needs_review", /review/],
  ["partially_refunded", /part of the deposit was already refunded/],
  ["refunded", /deposit was already refunded/],
];

/** Holds one armed call after its real reply arrived, until the test releases it (a slow PayPal or feed). */
function gate() {
  let armed = false;
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => (entered = r));
  const releasedP = new Promise<void>((r) => (release = r));
  return {
    arm() {
      armed = true;
    },
    /** Resolves once the armed call has its reply and is waiting. */
    entered: enteredP,
    release: () => release(),
    async pass<T>(call: () => Promise<T>): Promise<T> {
      if (!armed) return call();
      armed = false;
      const value = await call();
      entered();
      await releasedP;
      return value;
    },
  };
}
type Gate = ReturnType<typeof gate>;

const PAYMENT_METHODS = ["createOrder", "getOrder", "captureOrder", "refundCapture", "getRefund", "verifyWebhookSignature", "getOperatorIdentity"] as const;

/** The REST client, with `method`'s reply held by `g` while armed. */
function slow(inner: PaymentsApi, method: keyof PaymentsApi, g: Gate): PaymentsApi {
  const out: Record<string, unknown> = {};
  for (const k of PAYMENT_METHODS) {
    out[k] = (...args: unknown[]) => {
      const call = () => (inner[k] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
      return k === method ? g.pass(call) : call();
    };
  }
  return out as unknown as PaymentsApi;
}

const nextTask = () => new Promise((r) => setTimeout(r, 0));
/** Calls a method that was synchronous at 05c5037 and is async after the fix, as one promise. */
const later = <T>(fn: () => T): Promise<Awaited<T>> => Promise.resolve().then(fn) as Promise<Awaited<T>>;

function requested(w: World) {
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: DATE, party_size: 2, activity: "hike" });
  return { id: booking.id, token: tokenOf(operatorUrl) };
}

async function ordered(w: World) {
  const r = requested(w);
  await w.service.priceQuote(r.token, { total: "80", deposit: "30" });
  await w.service.proposeMandate(r.id);
  const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
  await w.service.approveMandate(mandate_id, code);
  w.fake.deliver = undefined;
  const b = await w.service.createOrder(r.id);
  return { ...r, orderId: b.order_id! };
}

async function paid(w: World) {
  const r = await ordered(w);
  w.fake.approve(r.orderId);
  expect((await w.service.captureIfApproved(r.id)).captured).toBe(true);
  return r;
}

const realAlert = (w: World) => w.weather.raise({ id: "TC-REAL-5", name: "Cyclone Real-5", level: "orange", from: DATE, to: DATE, summary: "" });
const kinds = (w: World, id: string) => w.ledger.list(id).map((e) => e.kind);

// ---------- F1 + F5: the simulation itself ----------

describe("F1: the simulation is accepted only on a captured booking", () => {
  it.each([...NOT_PAID, ...NOT_NOW.map(([s]) => s)])("a %s booking: refused, and nothing is saved, logged or announced", async (status) => {
    const w = makeWorld();
    const { id } = requested(w);
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, status });
    const before = { booking: w.service.get(id), rows: w.ledger.list(id).length, events: w.channels.pending(CONV) };
    await expect(later(() => w.service.simulateCyclone(id))).rejects.toBeInstanceOf(ServiceError);
    expect(w.service.get(id)).toEqual(before.booking);
    expect(w.service.get(id)!.simulated_alert).toBeUndefined();
    expect(w.ledger.list(id)).toHaveLength(before.rows);
    expect(w.channels.pending(CONV)).toBe(before.events);
  });

  it("a captured booking takes one simulated warning", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    w.channels.drain(CONV);
    const r = await later(() => w.service.simulateCyclone(id));
    expect(r.posted).toBe(true);
    expect(w.service.get(id)).toMatchObject({ status: "captured", simulated_alert: { source: "simulated", from: DATE, to: DATE } });
    expect(kinds(w, id).filter((k) => k === SIMULATED_KIND)).toHaveLength(1);
    expect(w.channels.pending(CONV)).toBe(1);
    expect((await later(() => w.service.simulateCyclone(id))).posted).toBe(false);
  });

  it("real feed alerts still reach every warnable booking, paid or not (WARNABLE is unchanged)", async () => {
    const w = makeWorld();
    const unpaid = requested(w);
    await w.service.priceQuote(unpaid.token, { total: "80", deposit: "30" });
    realAlert(w);
    expect(await w.service.announceCyclone(CONV)).toBe(1);
    expect(kinds(w, unpaid.id)).toContain("weather.alert");
  });
});

describe("F5: each refusal says accurately why", () => {
  async function refusal(status: BookingStatus): Promise<ServiceError> {
    const w = makeWorld();
    const { id } = requested(w);
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, status });
    try {
      await later(() => w.service.simulateCyclone(id));
    } catch (e) {
      if (e instanceof ServiceError) return e;
      throw e;
    }
    throw new Error(`${status}: the simulation was accepted`);
  }

  it.each(NOT_PAID)("not paid yet (%s): pay for the booking first, then simulate", async (status) => {
    const e = await refusal(status);
    expect(e.code).toBe("not_paid");
    expect(e.message).toMatch(/pay for the booking first, then simulate/);
    expect(e.message).not.toMatch(/once the guide has priced it/);
  });

  it.each(NOT_NOW)("finished or in processing (%s): it can't be simulated now, and why", async (status, why) => {
    const e = await refusal(status);
    expect(e.code).toBe("cannot_simulate");
    expect(e.message).toMatch(/can't be simulated now/);
    expect(e.message).toMatch(why);
    expect(e.message).not.toMatch(/once the guide has priced it/);
  });
});

describe("F1: the page enables Simulate only for a captured newest booking (sandbox), and says why otherwise", () => {
  const b = (status: string) => ({ booking_id: "bk_000000000001", status });

  it("sandbox: no booking, or the newest not captured, disables it with the reason", () => {
    const none = labels.simulateControl?.("sandbox", []);
    expect(none).toMatchObject({ disabled: true });
    expect(none.hint).toMatch(/pay/i);
    for (const s of NOT_PAID) {
      const v = labels.simulateControl?.("sandbox", [b(s)]);
      expect(v, s).toMatchObject({ disabled: true });
      expect(v.hint, s).toMatch(/pay for (your newest|the) booking first/i);
    }
    for (const [s, why] of NOT_NOW) {
      const v = labels.simulateControl?.("sandbox", [b(s)]);
      expect(v, s).toMatchObject({ disabled: true });
      expect(v.hint, s).toMatch(/can't simulate now/i);
      expect(v.hint, s).toMatch(why);
    }
  });

  it("sandbox: the newest booking decides (an older captured one doesn't enable it)", () => {
    expect(labels.simulateControl?.("sandbox", [b("captured"), b("priced")])).toMatchObject({ disabled: true });
    expect(labels.simulateControl?.("sandbox", [b("refunded"), b("captured")])).toEqual({ disabled: false, hint: "" });
  });

  it("fake mode is unchanged: enabled whenever the tab has a booking", () => {
    expect(labels.simulateControl?.("fake", [])).toEqual({ disabled: true, hint: "" });
    for (const s of [...NOT_PAID, "captured", "refunded"]) expect(labels.simulateControl?.("fake", [b(s)]), s).toEqual({ disabled: false, hint: "" });
  });
});

// ---------- F2: saves after an await merge onto the booking as it is now ----------

describe("F2: a change made while PayPal is answering is never wiped", () => {
  const ALERT: CycloneAlert = { id: "SIM-concurrent", name: "Demo cyclone (simulated)", level: "orange", from: DATE, to: DATE, source: "simulated", summary: "written meanwhile" };

  it("capture: a simulation pressed while the capture is in flight waits for it and survives it", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "captureOrder", g) });
    const { id, orderId } = await ordered(w);
    w.fake.approve(orderId);
    g.arm();
    const capturing = w.service.captureIfApproved(id);
    await g.entered; // PayPal captured; our save hasn't happened yet
    const simulating = later(() => w.service.simulateCyclone(id));
    await nextTask();
    g.release();
    const [cap, sim] = await Promise.all([capturing, simulating]);
    expect(cap.captured).toBe(true);
    expect(sim.posted).toBe(true);
    const b = w.service.get(id)!;
    expect(b.status).toBe("captured");
    // The ledger row and the booking agree: the warning that was logged is on the booking.
    expect(kinds(w, id).filter((k) => k === SIMULATED_KIND)).toHaveLength(1);
    expect(b.simulated_alert).toMatchObject({ source: "simulated", from: DATE });
    // One at a time: the simulation ran after the capture, on a captured booking.
    expect(kinds(w, id).indexOf("capture.completed")).toBeLessThan(kinds(w, id).indexOf(SIMULATED_KIND));
  });

  it("capture: the completed save merges onto the stored booking, not the copy read before PayPal answered", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "captureOrder", g) });
    const { id, orderId } = await ordered(w);
    w.fake.approve(orderId);
    g.arm();
    const capturing = w.service.captureIfApproved(id);
    await g.entered;
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, simulated_alert: ALERT, note: "changed meanwhile" });
    g.release();
    expect((await capturing).captured).toBe(true);
    expect(w.service.get(id)).toMatchObject({ status: "captured", capture_status: "COMPLETED", simulated_alert: ALERT, note: "changed meanwhile" });
  });

  it("capture: the needs_review save before capture merges onto the stored booking too", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "getOrder", g) });
    const { id, orderId } = await ordered(w);
    w.fake.approve(orderId);
    w.fake.mutateOrder(orderId, (o) => {
      o.purchase_units![0]!.amount = { currency_code: "EUR", value: "31.00" };
    });
    g.arm();
    const capturing = w.service.captureIfApproved(id);
    await g.entered;
    const records = new Records<Booking>(w.db, "booking");
    records.put({ ...records.get(id)!, simulated_alert: ALERT });
    g.release();
    await expect(capturing).rejects.toMatchObject({ code: "order_mismatch" });
    expect(w.service.get(id)).toMatchObject({ status: "needs_review", simulated_alert: ALERT });
  });

  it("refund refresh: the guide's refund offer made while PayPal answers the GET survives", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "getRefund", g) });
    const { id, token } = await paid(w);
    realAlert(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000005", status: "PENDING", amount: { currency_code: "EUR", value: "10.00" } } });
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "captured", refunded_minor: 0 });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000005", status: "COMPLETED", amount: { currency_code: "EUR", value: "10.00" } } });
    g.arm();
    const refreshing = w.service.refreshRefunds(id);
    await g.entered;
    await w.service.offerRefund(token);
    g.release();
    const after = await refreshing;
    expect(after).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_offered: true });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_offered: true });
    expect(kinds(w, id)).toEqual(expect.arrayContaining(["refund.offered", "refund.completed"]));
  });

  it("refund request: the guide's refund offer made while the weather feed answers survives", async () => {
    const g = gate();
    const w = makeWorld({ weather: (feed) => ({ alertsFor: (d) => g.pass(() => feed.alertsFor(d)) }) });
    const { id, token } = await paid(w);
    realAlert(w);
    g.arm();
    const refunding = w.service.refund(id, "10.00");
    await g.entered;
    await w.service.offerRefund(token);
    g.release();
    expect(await refunding).toMatchObject({ status: "partially_refunded", refunded_minor: 1000, refund_offered: true });
    expect(w.service.get(id)).toMatchObject({ status: "partially_refunded", refund_offered: true });
  });
});

// ---------- F3: refunds and reschedule answers ----------

describe("F3: a simulated warning never unlocks a refund by itself", () => {
  it("simulate, then ask for a refund: refused, and no money moves", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    await later(() => w.service.simulateCyclone(id));
    expect(await w.service.refundReason(w.service.get(id)!)).toBeUndefined();
    const refundCalls = () => w.fake.calls.filter((c) => c.path.endsWith("/refund")).length;
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed", message: expect.stringMatching(/simulated cyclone warning \(demo\) doesn't allow a refund by itself/) });
    expect(refundCalls()).toBe(0);
    expect(kinds(w, id).filter((k) => k.startsWith("refund."))).toEqual([]);
    expect(w.service.get(id)).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [] });
  });

  it("simulate → reschedule → the guide declines: the refund reads the guide's decline", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await later(() => w.service.simulateCyclone(id));
    await w.service.proposeReschedule(id, "2026-11-08");
    expect(await w.service.refundReason(w.service.get(id)!)).toBeUndefined();
    await applyOperatorAction(w.service, token, new URLSearchParams({ action: "decline_reschedule" }));
    expect(await w.service.refundReason(w.service.get(id)!)).toBe("the guide declined the reschedule");
    expect((await w.service.refund(id)).status).toBe("refunded");
    const requested = w.ledger.list(id).find((e) => e.kind === "refund.requested")!;
    expect(requested.data).toMatchObject({ reason: "the guide declined the reschedule" });
  });

  it("simulate → the guide offers a refund: allowed, for the guide's offer", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await later(() => w.service.simulateCyclone(id));
    await w.service.offerRefund(token);
    expect(await w.service.refundReason(w.service.get(id)!)).toBe("the guide offered it");
  });

  it("a real feed alert still allows a refund (rule a), with or without a simulated one", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    await later(() => w.service.simulateCyclone(id));
    realAlert(w);
    expect(await w.service.refundReason(w.service.get(id)!)).toBe("a cyclone warning covers the date");
  });
});

describe("F3: a reschedule can be answered only while the booking is captured", () => {
  async function refundedWithProposal() {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, "2026-11-08");
    await w.service.offerRefund(token);
    expect((await w.service.refund(id)).status).toBe("refunded");
    return { w, id, token };
  }

  it("a refunded booking: accept and decline are refused, the date stays, and the page hides the question", async () => {
    const { w, id, token } = await refundedWithProposal();
    const before = w.service.get(id)!;
    await expect(later(() => w.service.answerReschedule(token, true))).rejects.toThrow(ServiceError);
    await expect(later(() => w.service.answerReschedule(token, false))).rejects.toThrow(ServiceError);
    expect(w.service.get(id)).toMatchObject({ date: DATE, status: "refunded", reschedule: before.reschedule });
    // No answer was recorded. (Since round 6 the full refund itself withdraws the waiting move: fix6-withdrawn.)
    expect(kinds(w, id).filter((k) => k.startsWith("reschedule.") && k !== "reschedule.proposed")).toEqual(["reschedule.withdrawn"]);
    expect(renderOperatorPage(token, w.service.get(id)!)).not.toContain("Move the trip?");
    expect((await applyOperatorAction(w.service, token, new URLSearchParams({ action: "accept_reschedule" }))).ok).toBe(false);
  });

  it("a captured booking still shows and takes the answer", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, "2026-11-08");
    expect(renderOperatorPage(token, w.service.get(id)!)).toContain("Move the trip?");
    expect((await w.service.answerReschedule(token, true)).date).toBe("2026-11-08");
  });
});

// ---------- F4: one case-insensitive media-type check ----------

describe("F4: Content-Type is matched case-insensitively by the mutation check and the body reader", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    s = await startApp();
  });
  afterAll(async () => {
    await s?.app.close();
  });

  for (const type of ["Application/JSON", "APPLICATION/JSON; charset=UTF-8"]) {
    it(`/api/chat reads a "${type}" body`, async () => {
      const tab = new Browser(s.base);
      await tab.json("/api/conversations", {});
      const res = await tab.fetch("/api/chat", { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify({ conversation_id: tab.conv, message: "Find me a hiking guide for Le Morne on Thursday" }) });
      expect(res.status).toBe(200);
      expect((await res.json()).bookings).toHaveLength(1);
    });
  }

  it("a non-JSON type is still 415", async () => {
    const tab = new Browser(s.base);
    await tab.json("/api/conversations", {});
    const res = await tab.fetch("/api/chat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ conversation_id: tab.conv }) });
    expect(res.status).toBe(415);
  });
});

describe("F1 + F4 over HTTP in sandbox mode (the fake stands in for PayPal's sandbox)", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1:9/checkout" });
  beforeAll(async () => {
    s = await startApp(
      { PAYPAL_CLIENT_ID: FAKE_CLIENT_ID, PAYPAL_CLIENT_SECRET: FAKE_CLIENT_SECRET, PAYPAL_WEBHOOK_ID: FAKE_WEBHOOK_ID, PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1", PAYPAL_OPERATOR_MERCHANT_ID: "AMBREEOPER001" },
      { paypalFetch: fake.fetch },
    );
  });
  afterAll(async () => {
    await s?.app.close();
  });

  async function until(tab: Browser, pred: (x: State) => boolean, label: string): Promise<State> {
    for (let i = 0; i < 100; i++) {
      const st = await tab.json("/api/state");
      if (st.pending_events > 0) await tab.json("/api/chat", {});
      else if (pred(st)) return st;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  const simulate = (tab: Browser, id: string, type = "application/json") =>
    tab.fetch("/api/demo/cyclone", { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify({ conversation_id: tab.conv, booking_id: id }) });

  it("an unpaid booking is 409 with 'pay first' and records nothing; once paid, it is accepted (also as Application/JSON)", async () => {
    const tab = new Browser(s.base);
    const first = await tab.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday and hold the spot" });
    const id = first.bookings[0].booking_id as string;
    const link = first.guide_phone[0].url as string;
    await fetch(link, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "price", total: "80", deposit: "30" }) });
    let st = await until(tab, (x) => x.bookings[0]?.status === "mandate_proposed", "mandate");

    const early = await simulate(tab, id);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ ok: false, reason: "not_paid", error: expect.stringMatching(/pay for the booking first, then simulate/) });
    st = await tab.json("/api/state");
    expect(st.pending_events).toBe(0);
    expect((st.ledger as State[]).filter((e) => e.kind === SIMULATED_KIND)).toHaveLength(0);
    expect(st.bookings[0].simulated_warning).toBeNull();

    const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
    expect((await tab.json(`/api/mandates/${st.bookings[0].mandate.id}/approve`, { code })).ok).toBe(true);
    st = await until(tab, (x) => x.bookings[0]?.status === "order_created", "order");
    expect((await simulate(tab, id)).status).toBe(409);
    const orderId = st.bookings[0].order.id as string;
    fake.approve(orderId);
    await tab.fetch(`/paypal/return?booking=${id}&token=${orderId}`);
    await until(tab, (x) => x.bookings[0]?.status === "captured", "capture");

    const ok = await simulate(tab, id, "Application/JSON");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, simulated: true, posted: true, booking_id: id, date: DATE });
  });
});
