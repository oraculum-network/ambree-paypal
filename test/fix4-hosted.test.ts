// Round 4: the hosted demo (PayPal mode `sandbox`). The cyclone simulation works there, but only on the
// caller's own paid (captured) booking, once, labelled as simulated, and it never calls PayPal itself; the
// Demo controls show; "Start over" stays inside the caller's own session. Sandbox mode runs with no
// network: PayPal calls go to a stub that refuses (and counts) every call, or to the in-process fake.
// Round 5 (test/fix5-review.test.ts) narrowed it to captured bookings and took away its refund unlock.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_WEBHOOK_ID, FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { LiveEnvironmentRefused } from "../src/paypal/sandbox.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";
import { Browser, startApp } from "./helpers/server.ts";

// The guide's own app (DESIGN.md §21): each FakePayPal here registers it, as PayPal holds both apps.
const GUIDE_APP = fakeAppFor("GUIDEACCOUNT1");
const SANDBOX_ENV = {
  PAYPAL_CLIENT_ID: FAKE_CLIENT_ID,
  PAYPAL_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  PAYPAL_WEBHOOK_ID: FAKE_WEBHOOK_ID,
  PAYPAL_GUIDE_CLIENT_ID: GUIDE_APP.clientId,
  PAYPAL_GUIDE_CLIENT_SECRET: GUIDE_APP.clientSecret,
  PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1",
  PAYPAL_OPERATOR_MERCHANT_ID: "AMBREEOPER001",
};
const REQUEST = "Find me a hiking guide for Le Morne on Thursday and hold the spot";
const SIMULATED_KIND = "weather.simulated_alert";

type State = Record<string, any>;

function form(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}

/** Polls the tab's state, letting the agent handle pending events, until `pred` holds. */
async function until(tab: Browser, pred: (s: State) => boolean, label: string): Promise<State> {
  for (let i = 0; i < 100; i++) {
    const s = await tab.json("/api/state");
    if (s.pending_events > 0) await tab.json("/api/chat", {});
    else if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A new tab with one booking the guide has priced (no PayPal call happens on the way). */
async function pricedBooking(base: string): Promise<{ tab: Browser; id: string; link: string }> {
  const tab = new Browser(base);
  const first = await tab.json("/api/chat", { message: REQUEST });
  const link = first.guide_phone[0].url as string;
  expect((await form(link, { action: "price", total: "80", deposit: "30" })).status).toBe(200);
  return { tab, id: first.bookings[0].booking_id as string, link };
}

/** A new tab with one booking the traveller has paid (captured), through the fake standing in for PayPal. */
async function paidBooking(base: string, fake: FakePayPal): Promise<{ tab: Browser; id: string; link: string }> {
  const r = await pricedBooking(base);
  let st = await until(r.tab, (x) => x.bookings[0]?.status === "mandate_proposed", "mandate");
  const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
  expect((await r.tab.json(`/api/mandates/${st.bookings[0].mandate.id}/approve`, { code })).ok).toBe(true);
  st = await until(r.tab, (x) => x.bookings[0]?.status === "order_created", "order");
  const orderId = st.bookings[0].order.id as string;
  fake.approve(orderId);
  expect((await r.tab.fetch(`/paypal/return?booking=${r.id}&token=${orderId}`)).status).toBe(303);
  await until(r.tab, (x) => x.bookings[0]?.status === "captured", "capture");
  return r;
}

function simulate(tab: Browser, bookingId: string, headers: Record<string, string> = {}): Promise<Response> {
  return tab.fetch("/api/demo/cyclone", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ conversation_id: tab.conv, booking_id: bookingId }) });
}

const simulatedRows = (s: State) => (s.ledger as State[]).filter((e) => e.kind === SIMULATED_KIND);

describe("round 4: the cyclone simulation in sandbox mode (no PayPal call allowed)", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  const paypalCalls: string[] = [];
  const refusePayPal = (async (input: string | URL | Request) => {
    paypalCalls.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("no PayPal call is expected in this test");
  }) as typeof fetch;

  beforeAll(async () => {
    s = await startApp({ ...SANDBOX_ENV, PAYPAL_OPERATOR_IDENTITY: "config-only" }, { paypalFetch: refusePayPal });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("runs in sandbox mode and the page offers the simulated control", async () => {
    expect(await (await fetch(`${s.base}/healthz`)).json()).toMatchObject({ paypal: "sandbox" });
    const page = await (await fetch(`${s.base}/`)).text();
    expect(page).toContain("Simulate a cyclone warning (demo)");
    expect(page).not.toContain("Raise a cyclone warning");
  });

  it("another session's booking is 404 and nothing is posted", async () => {
    const victim = await pricedBooking(s.base);
    const before = await victim.tab.json("/api/state");
    const intruder = new Browser(s.base);
    await intruder.json("/api/conversations", {});
    for (const body of [{ booking_id: victim.id }, { booking_id: victim.id, conversation_id: victim.tab.conv }, { booking_id: "bk_000000000000" }, { booking_id: "not-a-booking" }]) {
      const res = await intruder.fetch("/api/demo/cyclone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    const after = await victim.tab.json("/api/state");
    expect(simulatedRows(after)).toHaveLength(0);
    expect(after.pending_events).toBe(before.pending_events);
  });

  it("without a session it is 401 and no session is created", async () => {
    const { id } = await pricedBooking(s.base);
    const bare = await fetch(`${s.base}/api/demo/cyclone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ booking_id: id }) });
    expect(bare.status).toBe(401);
    expect(bare.headers.getSetCookie()).toEqual([]);
    const unknown = await fetch(`${s.base}/api/demo/cyclone`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `amb_sid=${"A".repeat(43)}` }, body: JSON.stringify({ booking_id: id }) });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  it("a cross-origin or non-JSON request is refused before any session work", async () => {
    const { tab, id } = await pricedBooking(s.base);
    const cookie = tab.cookie;
    const cross = await simulate(tab, id, { Origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const plain = await tab.fetch("/api/demo/cyclone", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ booking_id: id }) });
    expect(plain.status).toBe(415);
    expect(tab.cookie).toBe(cookie);
    expect(simulatedRows(await tab.json("/api/state"))).toHaveLength(0);
  });

  it("a booking that isn't paid yet says so and records nothing (and no PayPal call is made)", async () => {
    const tab = new Browser(s.base);
    const first = await tab.json("/api/chat", { message: REQUEST });
    const id = first.bookings[0].booking_id as string;
    for (const step of ["requested", "priced"]) {
      if (step === "priced") expect((await form(first.guide_phone[0].url, { action: "price", total: "80", deposit: "30" })).status).toBe(200);
      const res = await simulate(tab, id);
      expect(res.status, step).toBe(409);
      expect(await res.json(), step).toMatchObject({ ok: false, reason: "not_paid", error: expect.stringMatching(/pay for the booking first, then simulate/) });
    }
    const st = await tab.json("/api/state");
    expect(simulatedRows(st)).toHaveLength(0);
    expect(st.bookings[0].simulated_warning).toBeNull();
    expect(paypalCalls).toEqual([]);
  });
});

describe("round 4: the simulation on a paid booking in sandbox mode (the fake stands in for PayPal; the simulation itself calls none)", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1:9/checkout", apps: [GUIDE_APP] });
  beforeAll(async () => {
    s = await startApp({ ...SANDBOX_ENV, PAYPAL_OPERATOR_IDENTITY: "config-only" }, { paypalFetch: fake.fetch });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("the caller's own paid booking: one simulated warning for that booking's day, labelled, and no PayPal call", async () => {
    const { tab, id } = await paidBooking(s.base, fake);
    const before = await tab.json("/api/state");
    const calls = fake.calls.length;
    const res = await simulate(tab, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, simulated: true, posted: true, booking_id: id, date: "2026-11-05" });

    const after = await tab.json("/api/state");
    expect(after.pending_events).toBe(before.pending_events + 1);
    expect(after.bookings[0].status).toBe("captured");
    const rows = simulatedRows(after);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ simulated: true, alert: { from: "2026-11-05", to: "2026-11-05", source: "simulated" } });
    expect(after.bookings[0].simulated_warning).toMatchObject({ date: "2026-11-05" });

    const chat = await tab.json("/api/chat", {});
    const events = (chat.transcript as State[]).filter((m) => m.role === "event").map((m) => m.text as string);
    expect(events.some((t) => /^\[event\] cyclone bk_[0-9a-f]{12}: Simulated cyclone warning \(demo\) for 2026-11-05/.test(t))).toBe(true);
    expect((await s.app.service.weatherFor(id)).alerts.map((a) => a.source)).toEqual(["simulated"]);
    expect(fake.calls.length).toBe(calls);
  });

  it("a second call posts no second warning (also when two calls race)", async () => {
    const { tab, id } = await paidBooking(s.base, fake);
    const calls = fake.calls.length;
    expect((await simulate(tab, id)).status).toBe(200);
    const once = await tab.json("/api/state");
    const again = await simulate(tab, id);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, simulated: true, posted: false, booking_id: id });
    const twice = await tab.json("/api/state");
    expect(simulatedRows(twice)).toHaveLength(1);
    expect(twice.pending_events).toBe(once.pending_events);
    expect(fake.calls.length).toBe(calls);

    const other = await paidBooking(s.base, fake);
    const raced = await Promise.all([simulate(other.tab, other.id), simulate(other.tab, other.id)]);
    const bodies = await Promise.all(raced.map((r) => r.json() as Promise<State>));
    expect(bodies.map((b) => b.posted).sort()).toEqual([false, true]);
    expect(simulatedRows(await other.tab.json("/api/state"))).toHaveLength(1);
  });

  it("the warning stays on that booking: another session's booking on the same day sees none", async () => {
    const mine = await paidBooking(s.base, fake);
    const theirs = await paidBooking(s.base, fake);
    expect((await simulate(mine.tab, mine.id)).status).toBe(200);
    expect((await s.app.service.weatherFor(mine.id)).alerts).toHaveLength(1);
    expect((await s.app.service.weatherFor(theirs.id)).alerts).toEqual([]);
    expect(simulatedRows(await theirs.tab.json("/api/state"))).toHaveLength(0);
  });
});

describe("round 4: sandbox mode end to end (the fake stands in for PayPal's sandbox)", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1:9/checkout", apps: [GUIDE_APP] });

  beforeAll(async () => {
    s = await startApp(SANDBOX_ENV, { paypalFetch: fake.fetch });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("paid booking → simulated warning (no PayPal call) → reschedule declined → refund", async () => {
    expect(await (await fetch(`${s.base}/healthz`)).json()).toMatchObject({ paypal: "sandbox", operator_identity: "confirmed" });
    const { tab, id, link } = await pricedBooking(s.base);
    let st = await until(tab, (x) => x.bookings[0]?.status === "mandate_proposed", "mandate");
    const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
    expect((await tab.json(`/api/mandates/${st.bookings[0].mandate.id}/approve`, { code })).ok).toBe(true);
    st = await until(tab, (x) => x.bookings[0]?.status === "order_created", "order");
    const orderId = st.bookings[0].order.id as string;
    fake.approve(orderId);
    expect((await tab.fetch(`/paypal/return?booking=${id}&token=${orderId}`)).status).toBe(303);
    st = await until(tab, (x) => x.bookings[0]?.status === "captured", "capture");
    // The guide's balance is the fake's own bookkeeping: never sent in sandbox mode.
    expect(st.bookings[0].guide_balance).toBeNull();
    expect(await s.app.service.refundReason(s.app.service.get(id)!)).toBeUndefined();

    const callsBefore = fake.calls.length;
    const res = await simulate(tab, id);
    expect(res.status).toBe(200);
    expect(fake.calls.length).toBe(callsBefore);
    expect(s.app.service.get(id)).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [] });
    // A simulated warning alone never unlocks a refund: it only gets the agent to propose a new date.
    expect(await s.app.service.refundReason(s.app.service.get(id)!)).toBeUndefined();

    st = await until(tab, (x) => x.bookings[0]?.reschedule?.status === "proposed", "reschedule");
    expect(st.transcript.at(-1).text).toMatch(/simulated cyclone warning \(demo\).*move the trip to 2026-11-08/i);
    // The traveller asks for the money back before the guide answers: refused, and nothing is sent.
    const asked = await tab.json("/api/chat", { message: "Please refund my deposit" });
    expect(asked.replies.at(-1)).toMatch(/didn't work.*doesn't allow a refund by itself/);
    expect(fake.calls.filter((c) => c.path.endsWith("/refund"))).toHaveLength(0);
    const question = await (await fetch(link)).text();
    expect(question).toContain("Move the trip?");
    // As the page's decline form posts it: it names the move it answers (round 8).
    await form(link, { action: "decline_reschedule", proposal: question.match(/name="proposal" value="([^"]+)"/)![1]! });

    st = await until(tab, (x) => x.bookings[0]?.status === "refunded", "refund");
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/refund"))).toHaveLength(1);
    // The refund (and so PayPal's note_to_payer) reads the guide's decline, not the simulated warning.
    expect((st.ledger as State[]).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "the guide declined the reschedule" });
    expect(await (await fetch(link)).text()).not.toContain("Move the trip?");
    const kinds = (st.ledger as State[]).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["capture.completed", SIMULATED_KIND, "reschedule.declined", "refund.completed"]));
    expect(kinds.filter((k) => k === SIMULATED_KIND)).toHaveLength(1);
    expect(st.chain.ok).toBe(true);
  });
});

describe("round 4: live PayPal is refused, so the simulation can never run live", () => {
  it("config refuses the live base URL", () => {
    expect(() => loadConfig({ ...SANDBOX_ENV, PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(LiveEnvironmentRefused);
  });

  it("the app refuses a hand-built config with the live base URL before serving anything", () => {
    const sandbox = loadConfig(SANDBOX_ENV);
    if (sandbox.paypal.mode !== "sandbox") throw new Error("expected sandbox mode");
    const live = { ...sandbox, paypal: { ...sandbox.paypal, baseUrl: "https://api-m.paypal.com" } };
    expect(() => createApp({ config: live })).toThrow(LiveEnvironmentRefused);
  });
});

describe("round 4: Start over stays inside the caller's session", () => {
  let s: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    s = await startApp({ ...SANDBOX_ENV, PAYPAL_OPERATOR_IDENTITY: "config-only" }, { paypalFetch: (async () => { throw new TypeError("no PayPal call expected"); }) as typeof fetch });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("another browser's Start over, even naming my conversation, leaves mine alone", async () => {
    const mine = new Browser(s.base);
    await mine.json("/api/chat", { message: REQUEST });
    const myConv = mine.conv!;
    const before = await mine.json("/api/state");
    expect(before.bookings).toHaveLength(1);

    const other = new Browser(s.base);
    const fresh = await other.json("/api/conversations", { conversation_id: myConv });
    expect(fresh.conversation_id).not.toBe(myConv);
    expect(fresh.bookings).toEqual([]);
    expect(other.cookie).not.toBe(mine.cookie);
    expect((await other.fetch(`/api/state?conversation_id=${myConv}`)).status).toBe(404);

    const after = await mine.json(`/api/state?conversation_id=${myConv}`);
    expect(after.bookings).toEqual(before.bookings);
    expect(after.transcript).toEqual(before.transcript);
  });

  it("my own Start over gives this tab a new, empty conversation and touches no one else's", async () => {
    const mine = new Browser(s.base);
    await mine.json("/api/chat", { message: REQUEST });
    const oldConv = mine.conv!;
    const other = new Browser(s.base);
    await other.json("/api/chat", { message: REQUEST });
    const theirs = await other.json("/api/state");

    const fresh = await mine.json("/api/conversations", {});
    expect(fresh.conversation_id).not.toBe(oldConv);
    expect(fresh.bookings).toEqual([]);
    expect(fresh.transcript).toEqual([]);
    expect((await mine.json(`/api/state?conversation_id=${oldConv}`)).bookings).toHaveLength(1);
    expect(await other.json("/api/state")).toMatchObject({ conversation_id: theirs.conversation_id, bookings: theirs.bookings });
  });
});

describe("round 4: what the page shows per PayPal mode", () => {
  it("Demo controls show in fake and sandbox mode; the guide's balance only with the fake", () => {
    expect(labels.demoView?.("sandbox")).toEqual({ controls: true, guideBalance: false });
    expect(labels.demoView?.("fake")).toEqual({ controls: true, guideBalance: true });
    expect(labels.demoView?.("live")).toEqual({ controls: false, guideBalance: false });
  });

  it("the control's reply is labelled simulated", () => {
    expect(labels.demoMessage?.({ ok: true, simulated: true, posted: true, date: "2026-11-05" })).toMatch(/^Simulated cyclone warning \(demo\) posted for 2026-11-05/);
    expect(labels.demoMessage?.({ ok: true, simulated: true, posted: false, date: "2026-11-05" })).toMatch(/already/);
    expect(labels.demoMessage?.({ error: "No such booking." })).toBe("No such booking.");
  });
});
