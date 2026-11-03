// Round 7: one booking's steps never interleave.
// S1 every step that changes a booking (or decides money on it) runs whole on the booking's queue
//    (#serial): the guide's price, decline, reschedule answer and refund offer, the agent's mandate and
//    move, the traveller's approval, the webhook's reaction, the simulation, the capture and the refund.
//    A step sent while another waits on PayPal or the weather feed waits for it, then decides on the
//    booking as that step left it. Different bookings don't wait for each other.
// S2 no move is proposed once a refund has started, and a refund that completes (partly or fully)
//    withdraws a move still waiting for the guide.
// S3 refund() decides its reason and reserves on one fresh read, with no await in between: a guide's
//    answer in the microtasks after the feed replied is never overwritten.
// The races are deterministic: test/helpers/race.ts's gate holds one PayPal reply or feed lookup.

import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/loop.ts";
import { ServiceError } from "../src/booking/service.ts";
import { renderOperatorPage } from "../src/operator/page.ts";
import { findTool, runTool } from "../src/tools/registry.ts";
import type { CycloneFeed, DemoCycloneFeed } from "../src/weather/cyclones.ts";
// @ts-expect-error plain browser module, no types
import * as labels from "../public/labels.js";
import { CONV, DATE, type Gate, type World, gate, kinds, later, ordered, paid, refundPosts, requested, slow } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const MOVED = "2026-11-08";
const QUESTION = "Move the trip?";
const STARTED = "A refund of the deposit has started, so the trip can't be moved.";

const nextTask = () => new Promise((r) => setTimeout(r, 0));
const realAlert = (w: World) => w.weather.raise({ id: "TC-R7", name: "Cyclone R7", level: "orange", from: DATE, to: DATE, summary: "" });

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
const outcome = <T>(p: Promise<T>): Promise<Outcome<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** A step's promise, and whether it has settled yet. */
function track<T>(p: Promise<T>) {
  let settled = false;
  const done = outcome(p).finally(() => {
    settled = true;
  });
  return {
    get settled() {
      return settled;
    },
    done,
  };
}

/** Calls `fn` after `k` microtasks (k = 0: now, synchronously), as one promise. */
function after<T>(k: number, fn: () => T): Promise<Awaited<T>> {
  if (k === 0) {
    try {
      return Promise.resolve(fn()) as Promise<Awaited<T>>;
    } catch (e) {
      return Promise.reject(e);
    }
  }
  let p: Promise<unknown> = Promise.resolve();
  for (let i = 1; i < k; i++) p = p.then(() => undefined);
  return p.then(fn) as Promise<Awaited<T>>;
}

/** Fails fast when a step on another booking waits (it should not). */
function within<T>(p: Promise<T>, label: string, ms = 1000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} waited on another booking`)), ms))]);
}

/** A world whose feed lookups are held by `g` while it is armed. */
function feedWorld(g: Gate): World {
  return makeWorld({ weather: (feed: DemoCycloneFeed): CycloneFeed => ({ alertsFor: (d) => g.pass(() => feed.alertsFor(d)) }) });
}

/**
 * No lost update: the stored booking says what its ledger says. The guide's offer, every reserved and
 * completed refund, the simulated warning and the last move (proposed, then at most one of accepted,
 * declined or withdrawn) are on the booking, and its date is where the last accepted move put it.
 */
function agrees(w: World, id: string, label = "") {
  const b = w.service.get(id)!;
  const rows = w.ledger.list(id);
  const k = rows.map((r) => r.kind);
  const count = (kind: string) => k.filter((x) => x === kind).length;
  expect(b.refund_offered, `${label} refund_offered`).toBe(k.includes("refund.offered"));
  expect(b.refund_ops.length, `${label} refund ops reserved`).toBe(count("refund.requested"));
  expect(b.refund_ops.filter((o) => o.status === "completed").length, `${label} refunds completed`).toBe(count("refund.completed"));
  expect(Boolean(b.simulated_alert), `${label} simulated warning`).toBe(k.includes("weather.simulated_alert"));
  const moves = rows.filter((r) => r.kind.startsWith("reschedule."));
  const last = moves.map((r) => r.kind).lastIndexOf("reschedule.proposed");
  if (last === -1) expect(b.reschedule, `${label} reschedule`).toBeUndefined();
  else {
    const tail = moves.slice(last + 1).map((r) => r.kind.slice("reschedule.".length));
    expect(tail.length, `${label} answers after the last proposal: ${tail.join(", ")}`).toBeLessThanOrEqual(1);
    expect(b.reschedule?.status, `${label} reschedule status`).toBe(tail[0] ?? "proposed");
  }
  const accepted = moves.filter((r) => r.kind === "reschedule.accepted");
  expect(b.date, `${label} date`).toBe(accepted.length ? (accepted.at(-1)!.data as { to: string }).to : DATE);
}

// ---------- S1 ----------

describe("S1: a step sent while another waits on the feed or PayPal waits for it", () => {
  it("accept vs refund: the guide's accept waits for the refund, which is decided on the date it looked up", async () => {
    const g = gate();
    const w = feedWorld(g);
    const { id, token } = await paid(w);
    realAlert(w); // a real warning on 11-05 only
    await w.service.proposeReschedule(id, MOVED);
    g.arm();
    const refunding = track(w.service.refund(id));
    await g.entered; // the feed said 11-05 is covered; nothing is reserved yet
    const accepting = track(later(() => w.service.answerReschedule(token, true)));
    await nextTask();
    expect(accepting.settled, "the accept ran while the refund was deciding").toBe(false);
    expect(w.service.get(id)).toMatchObject({ date: DATE, reschedule: { status: "proposed" } });
    g.release();
    expect(await refunding.done).toMatchObject({ ok: true, value: { status: "refunded", date: DATE } });
    const a = await accepting.done;
    expect(a.ok).toBe(false);
    expect((a as { error: unknown }).error).toBeInstanceOf(ServiceError);
    expect(kinds(w, id)).not.toContain("reschedule.accepted");
    expect(refundPosts(w)).toBe(1);
    agrees(w, id);
  });

  it("decline vs refund: the guide's decline waits; the refund is decided without it, then a retry reads it", async () => {
    const g = gate();
    const w = feedWorld(g);
    const { id, token } = await paid(w);
    await w.service.proposeReschedule(id, MOVED);
    g.arm();
    const refunding = track(w.service.refund(id));
    await g.entered; // no warning: the move is still open, so the feed decides
    const declining = track(later(() => w.service.answerReschedule(token, false)));
    await nextTask();
    expect(declining.settled, "the decline ran while the refund was deciding").toBe(false);
    g.release();
    expect(await refunding.done).toMatchObject({ ok: false, error: { code: "refund_not_allowed" } });
    expect(await declining.done).toMatchObject({ ok: true, value: { reschedule: { status: "declined" } } });
    expect(refundPosts(w)).toBe(0);
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded" });
    expect(w.ledger.list(id).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "the guide declined the reschedule" });
    agrees(w, id);
  });

  it("offer vs refund (the feed): the guide's offer waits; the refund is decided without it, then a retry reads it", async () => {
    const g = gate();
    const w = feedWorld(g);
    const { id, token } = await paid(w);
    g.arm();
    const refunding = track(w.service.refund(id));
    await g.entered;
    const offering = track(later(() => w.service.offerRefund(token)));
    await nextTask();
    expect(offering.settled, "the offer ran while the refund was deciding").toBe(false);
    expect(w.service.get(id)!.refund_offered).toBe(false);
    g.release();
    expect(await refunding.done).toMatchObject({ ok: false, error: { code: "refund_not_allowed" } });
    expect(await offering.done).toMatchObject({ ok: true, value: { refund_offered: true } });
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded" });
    expect(w.ledger.list(id).find((e) => e.kind === "refund.requested")!.data).toMatchObject({ reason: "the guide offered it" });
    agrees(w, id);
  });

  it("offer vs refund (PayPal): an offer sent while the refund's POST is held lands after it, on the partly refunded booking", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const { id, token } = await paid(w);
    realAlert(w);
    g.arm();
    const refunding = track(w.service.refund(id, "10.00"));
    await g.entered;
    const offering = track(later(() => w.service.offerRefund(token)));
    await nextTask();
    expect(offering.settled, "the offer ran while PayPal was answering the refund").toBe(false);
    g.release();
    expect(await refunding.done).toMatchObject({ ok: true, value: { status: "partially_refunded" } });
    expect(await offering.done).toMatchObject({ ok: true, value: { status: "partially_refunded", refund_offered: true } });
    const k = kinds(w, id);
    expect(k.indexOf("refund.completed")).toBeLessThan(k.indexOf("refund.offered"));
    agrees(w, id);
  });

  it("the agent's move vs a refund whose POST is held: the move waits, then is refused on the refunded booking", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    g.arm();
    const refunding = track(w.service.refund(id));
    await g.entered;
    const moving = track(later(() => w.service.proposeReschedule(id, MOVED)));
    await nextTask();
    expect(moving.settled, "the move was proposed while PayPal was answering the refund").toBe(false);
    g.release();
    expect(await refunding.done).toMatchObject({ ok: true, value: { status: "refunded" } });
    expect(await moving.done).toMatchObject({ ok: false, error: { code: "wrong_state" } });
    expect(kinds(w, id)).not.toContain("reschedule.proposed");
    agrees(w, id);
  });

  it("webhook capture vs simulate: a simulation pressed while the webhook's capture waits on PayPal runs after it", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "captureOrder", g) });
    const { id, orderId } = await ordered(w);
    w.fake.deliver = async (raw, headers) => {
      w.webhookResults.push(await w.service.handleWebhook(raw, headers));
    };
    g.arm();
    w.fake.approve(orderId); // CHECKOUT.ORDER.APPROVED: the webhook captures
    await g.entered; // PayPal captured; the webhook's save is held
    const simulating = track(later(() => w.service.simulateCyclone(id)));
    await nextTask();
    expect(simulating.settled).toBe(false);
    expect(w.service.get(id)!.status).toBe("order_created");
    g.release();
    expect(await simulating.done).toMatchObject({ ok: true, value: { posted: true, booking: { status: "captured" } } });
    await w.fake.flush();
    await w.fake.flush();
    expect(w.webhookResults.map((r) => r.result)).toEqual(["logged", "logged"]);
    const k = kinds(w, id);
    expect(k.indexOf("capture.completed")).toBeLessThan(k.indexOf("weather.simulated_alert"));
    agrees(w, id);
  });

  it("a webhook that arrives while a refund waits on PayPal is handled after it: its row follows the refund's", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const { id, token } = await paid(w);
    // The refund's event comes on the guide app's webhook, so to the guide endpoint (DESIGN.md §21).
    w.fake.deliver = async (raw, headers, to) => {
      w.webhookResults.push(await w.webhook({ raw, headers, to }));
    };
    await w.service.offerRefund(token);
    g.arm();
    const refunding = w.service.refund(id);
    await g.entered; // PayPal refunded and sent PAYMENT.CAPTURE.REFUNDED; our save is held
    // The webhook is delivered and verified meanwhile (not awaited: its handler waits for the refund).
    const verified = () => w.fake.calls.some((c) => c.path.endsWith("/verify-webhook-signature"));
    for (let i = 0; i < 50 && !verified(); i++) await nextTask();
    expect(verified()).toBe(true);
    await nextTask(); // the handler has gone as far as it can
    expect(kinds(w, id), "the webhook was handled while the refund was held").not.toContain("webhook.PAYMENT.CAPTURE.REFUNDED");
    g.release();
    expect(await refunding).toMatchObject({ status: "refunded" });
    await w.fake.flush();
    expect(w.webhookResults.map((r) => r.result)).toEqual(["logged"]);
    const k = kinds(w, id);
    expect(k.indexOf("refund.completed"), k.join(", ")).toBeLessThan(k.indexOf("webhook.PAYMENT.CAPTURE.REFUNDED"));
    agrees(w, id);
  });

  it("fake mode's demo warning vs a refund whose POST is held: the announcement waits, then reads the refunded booking", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    g.arm();
    const refunding = track(w.service.refund(id));
    await g.entered; // PayPal refunded; the booking is still `captured` with the operation `sending`
    w.weather.raise({ id: "TC-R7-DEMO", name: "Cyclone Demo-1 (demo)", level: "orange", from: DATE, to: DATE, summary: "" });
    const announcing = track(later(() => w.service.announceCyclone(CONV)));
    await nextTask();
    expect(announcing.settled, "the warning was announced while PayPal was answering the refund").toBe(false);
    g.release();
    expect(await refunding.done).toMatchObject({ ok: true, value: { status: "refunded" } });
    expect(await announcing.done).toEqual({ ok: true, value: 0 });
    expect(kinds(w, id)).not.toContain("weather.alert");
    expect(w.channels.drain(CONV).filter((e) => e.type === "cyclone")).toEqual([]);
  });

  it("price/confirm vs a money step: the guide's price and decline, a new mandate and the traveller's approval wait for the order", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "createOrder", g) });
    const r = requested(w);
    await w.service.priceQuote(r.token, { total: "80", deposit: "30" });
    await w.service.proposeMandate(r.id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    await w.service.approveMandate(mandate_id, code);
    w.fake.deliver = undefined;
    g.arm();
    const creating = track(w.service.createOrder(r.id));
    await g.entered; // PayPal created the order; our save is held
    const steps = {
      propose: track(later(() => w.service.proposeMandate(r.id))),
      approve: track(later(() => w.service.approveMandate(mandate_id, code))),
      price: track(later(() => w.service.priceQuote(r.token, { total: "90", deposit: "40" }))),
      decline: track(later(() => w.service.declineRequest(r.token))),
    };
    await nextTask();
    expect(Object.fromEntries(Object.entries(steps).map(([k, s]) => [k, s.settled]))).toEqual({ propose: false, approve: false, price: false, decline: false });
    g.release();
    expect(await creating.done).toMatchObject({ ok: true, value: { status: "order_created" } });
    // Each decides on the booking as the order left it.
    expect(await steps.propose.done).toMatchObject({ ok: false, error: { code: "wrong_state", message: expect.stringMatching(/order_created/) } });
    expect(await steps.approve.done).toMatchObject({ ok: false, error: { code: "not_proposed" } });
    expect(await steps.price.done).toMatchObject({ ok: false, error: { code: "already_answered" } });
    expect(await steps.decline.done).toMatchObject({ ok: false, error: { code: "already_answered" } });
    expect(w.service.get(r.id)).toMatchObject({ status: "order_created", mandate_id, quote: { total: { value: "80.00" } } });
  });

  it("price vs decline sent together (two tabs): exactly one answer stands", async () => {
    const w = makeWorld();
    const r = requested(w);
    const [price, decline] = await Promise.all([outcome(later(() => w.service.priceQuote(r.token, { total: "80", deposit: "30" }))), outcome(later(() => w.service.declineRequest(r.token)))]);
    expect([price.ok, decline.ok].filter(Boolean)).toHaveLength(1);
    expect(kinds(w, r.id).filter((k) => k === "quote.priced" || k === "quote.declined")).toHaveLength(1);
  });

  it("different bookings don't wait for each other: while one refund is held at PayPal, another booking moves, gets an offer and a simulation", async () => {
    const g = gate();
    const w = makeWorld({ payments: (p) => slow(p, "refundCapture", g) });
    const a = await paid(w);
    const b = await paid(w);
    await w.service.offerRefund(a.token);
    g.arm();
    const refunding = w.service.refund(a.id);
    await g.entered;
    await within(later(() => w.service.proposeReschedule(b.id, MOVED)), "proposeReschedule");
    await within(later(() => w.service.answerReschedule(b.token, true)), "answerReschedule");
    await within(later(() => w.service.offerRefund(b.token)), "offerRefund");
    await within(later(() => w.service.simulateCyclone(b.id)), "simulateCyclone");
    expect(w.service.get(b.id)).toMatchObject({ date: MOVED, refund_offered: true, reschedule: { status: "accepted" } });
    g.release();
    expect(await refunding).toMatchObject({ status: "refunded" });
    agrees(w, a.id, "a");
  });
});

// ---------- S2 ----------

const pendingRefund = (w: World, value: string, n: string) =>
  w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: `RPEND0000000000${n}`, status: "PENDING", amount: { currency_code: "EUR", value } } });

describe("S2: no move once a refund has started", () => {
  it("a refund pending at PayPal: the move is refused (wrong_state) and nothing is asked of the guide", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    pendingRefund(w, "30.00", "71");
    expect(await w.service.refund(id)).toMatchObject({ status: "captured", refund_ops: [{ status: "pending" }] });
    expect(await outcome(later(() => w.service.proposeReschedule(id, MOVED)))).toMatchObject({ ok: false, error: { code: "wrong_state", message: STARTED } });
    expect(w.service.get(id)!.reschedule).toBeUndefined();
    expect(kinds(w, id)).not.toContain("reschedule.proposed");
    expect(renderOperatorPage(token, w.service.get(id)!)).not.toContain(QUESTION);
  });

  it("the agent's tool says so too, rather than 'the guide was asked'", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    realAlert(w);
    pendingRefund(w, "10.00", "72");
    await w.service.refund(id, "10.00");
    const out = await runTool("propose_reschedule", { booking_id: id, new_date: MOVED }, { service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
    expect(out).toEqual({ ok: false, message: `wrong_state: ${STARTED}` });
  });

  it("kept: a refund PayPal refused (failed) blocks nothing", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    realAlert(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_NOT_ALLOWED", description: "refused" }] } });
    await expect(w.service.refund(id)).rejects.toMatchObject({ status: 422 });
    expect(await w.service.proposeReschedule(id, MOVED)).toMatchObject({ reschedule: { status: "proposed" } });
  });
});

describe("S2: a refund that completes, partly or fully, withdraws a move still waiting for the guide", () => {
  it("a partial refund: partially refunded, the move withdrawn and logged after the refund, with the reason", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    const b = await w.service.refund(id, "10.00");
    expect(b).toMatchObject({ status: "partially_refunded", date: DATE, reschedule: { new_date: MOVED, status: "withdrawn" } });
    const k = kinds(w, id);
    expect(k.filter((x) => x === "reschedule.withdrawn")).toHaveLength(1);
    expect(k.indexOf("refund.completed")).toBeLessThan(k.indexOf("reschedule.withdrawn"));
    expect(w.ledger.list(id).find((e) => e.kind === "reschedule.withdrawn")!.data).toEqual({ from: DATE, to: MOVED, reason: "part of the deposit was refunded" });
    expect(renderOperatorPage(token, b)).not.toContain(QUESTION);
    expect(await outcome(later(() => w.service.answerReschedule(token, true)))).toMatchObject({ ok: false, error: { code: "no_reschedule" } });
    // The rest can still be refunded; nothing more is withdrawn.
    expect(await w.service.refund(id)).toMatchObject({ status: "refunded", reschedule: { status: "withdrawn" } });
    expect(kinds(w, id).filter((x) => x === "reschedule.withdrawn")).toHaveLength(1);
    agrees(w, id);
  });

  it("a partial refund that completes later (PENDING, then COMPLETED by GET) withdraws it too", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    pendingRefund(w, "10.00", "73");
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "captured", reschedule: { status: "proposed" } });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000073", status: "COMPLETED", amount: { currency_code: "EUR", value: "10.00" } } });
    expect(await w.service.refreshRefunds(id)).toMatchObject({ status: "partially_refunded", reschedule: { status: "withdrawn" } });
    expect(w.ledger.list(id).find((e) => e.kind === "reschedule.withdrawn")!.data).toMatchObject({ reason: "part of the deposit was refunded" });
    agrees(w, id);
  });

  it("the agent's refund event says the move was withdrawn, so it doesn't keep waiting for the guide", async () => {
    const w = makeWorld();
    const { id } = await paid(w);
    realAlert(w);
    await w.service.proposeReschedule(id, MOVED);
    w.channels.drain(CONV);
    await w.service.refund(id, "10.00");
    const refunded = w.channels.drain(CONV).filter((e) => e.type === "refunded");
    expect(refunded).toHaveLength(1);
    expect(refunded[0]!.text).toMatch(new RegExp(`The move to ${MOVED} is withdrawn: the guide is no longer asked\\.$`));
    // A refund with no waiting move says nothing about one.
    await w.service.refund(id);
    expect(w.channels.drain(CONV).find((e) => e.type === "refunded")!.text).not.toMatch(/withdrawn/);
  });

  it("the traveller's card says why: part of the deposit, or the deposit", () => {
    const card = (status: string) => labels.rescheduleLine({ status, reschedule: { new_date: MOVED, status: "withdrawn" } });
    expect(card("partially_refunded")).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: withdrawn, because part of the deposit was refunded.` });
    expect(card("refunded")).toEqual({ testid: "reschedule", text: `Reschedule to ${MOVED}: withdrawn, because the deposit was refunded.` });
  });
});

// ---------- S3 ----------

const STEPS = ["accept", "decline", "offer"] as const;
const CASES = STEPS.flatMap((step) => [0, 1, 2, 3, 4, 5].map((k) => [step, k] as const));

describe("S3: no lost update in the microtasks after the feed's reply", () => {
  it.each(CASES)("%s, %i microtasks after the reply", async (step, k) => {
    let fire: (() => void) | undefined;
    const w = makeWorld({
      weather: (feed: DemoCycloneFeed): CycloneFeed => ({
        alertsFor: async (d) => {
          const reply = await feed.alertsFor(d);
          const f = fire;
          fire = undefined;
          f?.();
          return reply;
        },
      }),
    });
    const { id, token } = await paid(w);
    realAlert(w);
    if (step !== "offer") await w.service.proposeReschedule(id, MOVED);
    let answered: Promise<Outcome<unknown>> | undefined;
    fire = () => {
      answered = outcome(after(k, () => (step === "offer" ? w.service.offerRefund(token) : w.service.answerReschedule(token, step === "accept"))));
    };
    const refunded = await outcome(w.service.refund(id, "10.00"));
    expect(answered, "the feed was asked").toBeDefined();
    const answer = await answered!;
    agrees(w, id, `${step}@${k}`);
    // The answer queues behind the refund, which was asked first.
    expect(refunded).toMatchObject({ ok: true, value: { status: "partially_refunded", date: DATE } });
    expect(refundPosts(w)).toBe(1);
    if (step === "offer") expect(answer).toMatchObject({ ok: true, value: { refund_offered: true } });
    else {
      expect(answer).toMatchObject({ ok: false, error: { code: "no_reschedule" } });
      expect(w.service.get(id)).toMatchObject({ date: DATE, reschedule: { status: "withdrawn" } });
    }
  });
});

// ---------- what a real model is told ----------

describe("the model is told what `withdrawn` and `date_changed` mean", () => {
  it("the system prompt names both and says what to do", () => {
    const p = systemPrompt("2026-11-03");
    expect(p).toMatch(/withdrawn/);
    expect(p).toMatch(/date_changed/);
    expect(p).toMatch(/date_changed[^\n]*(again|retry)/i);
  });

  it("get_booking, propose_reschedule and refund_payment describe them", () => {
    expect(findTool("get_booking")!.description).toMatch(/withdrawn/);
    expect(findTool("propose_reschedule")!.description).toMatch(/refund[^.]*started|started[^.]*refund/i);
    expect(findTool("refund_payment")!.description).toMatch(/date_changed/);
    expect(findTool("refund_payment")!.description).toMatch(/withdrawn/);
  });
});
