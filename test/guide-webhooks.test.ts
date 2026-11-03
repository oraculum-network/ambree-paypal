// D4 and D5's webhooks (DESIGN.md §21). Each PayPal app has its own webhook id. /webhooks/paypal is
// verified through the operator's app and PAYPAL_WEBHOOK_ID; /webhooks/paypal/guide through the guide's app
// and PAYPAL_GUIDE_WEBHOOK_ID; after verification both feed the same handler. It is unknown which app's
// webhook PayPal uses for a refund made with the guide's app, so a refund event may arrive on either, or both:
// the same event (same id) arriving on both is processed once (the handler's dedupe by event id), and a
// webhook is never accepted on the other endpoint's id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_WEBHOOK_ID, type FakeApp, FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { type WebhookEvent, transmissionFromHeaders } from "../src/paypal/types.ts";
import { type Delivery, type World, keepWebhooks, paid } from "./helpers/race.ts";
import { Browser, startApp } from "./helpers/server.ts";
import { makeWorld } from "./helpers/world.ts";

const eur = (value: string) => ({ currency_code: "EUR" as const, value });
const eventOf = (d: Delivery) => JSON.parse(d.raw) as WebhookEvent;
const rowsOf = (w: World, id: string, kind: string) => w.ledger.list(id).filter((e) => e.kind === kind);

describe("D5: the fake sends each event on the webhook of the app it concerns", () => {
  async function setup(both = false) {
    const guideApp = fakeAppFor("GUIDEACCOUNT1");
    const got: Array<{ raw: string; headers: Record<string, string>; to: FakeApp }> = [];
    const fake = new FakePayPal({ apps: [guideApp], deliver: (raw, headers, to) => void got.push({ raw, headers, to }) });
    fake.refundEventsOnBoth = both;
    const operator = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, webhookId: fake.webhookId, fetch: fake.fetch });
    const guide = new PayPalRestClient({ clientId: guideApp.clientId, clientSecret: guideApp.clientSecret, webhookId: guideApp.webhookId, fetch: fake.fetch });
    const o = await operator.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("30.00"), payee: { merchant_id: "GUIDEACCOUNT1" }, custom_id: "bk_000000000001" }] }, "o1");
    fake.approve(o.id);
    const captureId = (await operator.captureOrder(o.id, "c1")).purchase_units![0]!.payments!.captures![0]!.id;
    await fake.flush();
    return { fake, got, operator, guide, guideApp, captureId };
  }
  const verifyWith = (client: PayPalRestClient, d: { raw: string; headers: Record<string, string> }) => client.verifyWebhookSignature(transmissionFromHeaders(d.headers)!, JSON.parse(d.raw) as WebhookEvent);

  it("order and capture events: the operator's webhook; a refund's events: the refunding app's; each verifies only with its own app and id", async () => {
    const s = await setup();
    expect(s.got.map((d) => [eventOf(d).event_type, d.to.clientId])).toEqual([
      ["CHECKOUT.ORDER.APPROVED", FAKE_CLIENT_ID],
      ["PAYMENT.CAPTURE.COMPLETED", FAKE_CLIENT_ID],
    ]);
    s.got.length = 0;
    await s.guide.refundCapture(s.captureId, { amount: eur("10.00") }, "rf1");
    s.fake.pendNextRefund();
    const pending = await s.guide.refundCapture(s.captureId, { amount: eur("5.00") }, "rf2");
    s.fake.settleRefund(pending.id, "FAILED");
    await s.fake.flush();
    expect(s.got.map((d) => [eventOf(d).event_type, d.to.clientId, d.to.webhookId])).toEqual([
      ["PAYMENT.CAPTURE.REFUNDED", s.guideApp.clientId, s.guideApp.webhookId],
      ["PAYMENT.REFUND.FAILED", s.guideApp.clientId, s.guideApp.webhookId],
    ]);
    for (const d of s.got) {
      expect(await verifyWith(s.guide, d)).toBe(true);
      expect(await verifyWith(s.operator, d)).toBe(false);
    }
  });

  it("refundEventsOnBoth: the same event (same id) also goes to the operator's webhook, as its own transmission", async () => {
    const s = await setup(true);
    s.got.length = 0;
    await s.guide.refundCapture(s.captureId, {}, "rf1");
    await s.fake.flush();
    expect(s.got.map((d) => d.to.clientId)).toEqual([s.guideApp.clientId, FAKE_CLIENT_ID]);
    const [a, b] = s.got;
    expect(eventOf(a!).id).toBe(eventOf(b!).id);
    expect(a!.headers["paypal-transmission-id"]).not.toBe(b!.headers["paypal-transmission-id"]);
    expect(await verifyWith(s.guide, a!)).toBe(true);
    expect(await verifyWith(s.operator, b!)).toBe(true);
    // Never on the other's id: each transmission is signed for one webhook.
    expect(await verifyWith(s.operator, a!)).toBe(false);
    expect(await verifyWith(s.guide, b!)).toBe(false);
  });
});

describe("D4: two endpoints, one handler (the booking service)", () => {
  /** Paid; the guide offered a refund; webhooks kept (each with the app whose webhook it came on). */
  async function offered(both = false) {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    const got = keepWebhooks(w);
    w.fake.refundEventsOnBoth = both;
    return { w, id, got };
  }

  it("a refund event from the guide's app is accepted on the guide endpoint only; an order event on the operator's only", async () => {
    const { w, id, got } = await offered();
    expect(await w.service.refund(id, "10.00")).toMatchObject({ status: "partially_refunded" });
    await w.fake.flush();
    const [refunded] = got;
    expect(refunded!.to!.clientId).not.toBe(w.fake.clientId);
    expect(await w.webhook({ ...refunded!, to: undefined })).toEqual({ status: 400, result: "signature not verified" });
    expect(await w.webhook(refunded!)).toEqual({ status: 200, result: "logged" });
    expect(rowsOf(w, id, "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1);
    // An operator-app event handed to the guide endpoint is refused too.
    w.fake.emitWebhook("PAYMENT.CAPTURE.COMPLETED", "capture", { id: w.service.get(id)!.capture_id, status: "COMPLETED", custom_id: id });
    await w.fake.flush();
    const completed = got.at(-1)!;
    expect(completed.to!.clientId).toBe(w.fake.clientId);
    expect(await w.webhook({ ...completed, to: refunded!.to })).toEqual({ status: 400, result: "signature not verified" });
  });

  it("the same refund event on both endpoints, one after the other: logged and acted on once; the second is a duplicate", async () => {
    const { w, id, got } = await offered(true);
    // The refund's reply is lost, so only its event can settle it (I2): an event processed twice would show.
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    expect(got.map((d) => eventOf(d).event_type)).toEqual(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REFUNDED"]);
    expect(eventOf(got[0]!).id).toBe(eventOf(got[1]!).id);
    expect(await w.webhook(got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(await w.webhook(got[1]!)).toEqual({ status: 200, result: "duplicate" });
    expect(rowsOf(w, id, "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1);
    expect(rowsOf(w, id, "refund.recovered")).toHaveLength(1);
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000, refund_ops: [{ status: "completed" }] });
  });

  it("the same refund event on both endpoints at once: one is processed, the other waits on the booking's queue and is a duplicate", async () => {
    const { w, id, got } = await offered(true);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    const results = await Promise.all([w.webhook(got[1]!), w.webhook(got[0]!)]);
    expect(results.map((r) => r.result).sort()).toEqual(["duplicate", "logged"]);
    expect(rowsOf(w, id, "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1);
    expect(rowsOf(w, id, "refund.recovered")).toHaveLength(1);
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refunded_minor: 3000 });
  });

  it("a first delivery whose processing failed (500) is processed by the other endpoint's, as by a redelivery", async () => {
    const { w, id, got } = await offered(true);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    // The evidence GET fails (twice: the client retries a GET once), so the first delivery answers 500.
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 503, body: {} });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 503, body: {} });
    expect(await w.webhook(got[0]!)).toMatchObject({ status: 500 });
    expect(await w.webhook(got[1]!)).toEqual({ status: 200, result: "logged" });
    expect(rowsOf(w, id, "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1);
    expect(w.service.get(id)).toMatchObject({ status: "refunded" });
  });
});

describe("D4 over HTTP", () => {
  const GUIDE_APP = fakeAppFor("GUIDEACCOUNT1");
  const SANDBOX_ENV = {
    PAYPAL_CLIENT_ID: FAKE_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    PAYPAL_WEBHOOK_ID: FAKE_WEBHOOK_ID,
    PAYPAL_GUIDE_CLIENT_ID: GUIDE_APP.clientId,
    PAYPAL_GUIDE_CLIENT_SECRET: GUIDE_APP.clientSecret,
    PAYPAL_GUIDE_WEBHOOK_ID: GUIDE_APP.webhookId!,
    PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1",
    PAYPAL_OPERATOR_MERCHANT_ID: "AMBREEOPER001",
  };
  const post = (base: string, path: string, d: { raw: string; headers: Record<string, string> }) => fetch(`${base}${path}`, { method: "POST", headers: d.headers, body: d.raw });

  describe("sandbox mode, the fake standing in for PayPal", () => {
    let s: Awaited<ReturnType<typeof startApp>>;
    const got: Array<{ raw: string; headers: Record<string, string>; to: FakeApp }> = [];
    const fake = new FakePayPal({ checkoutUrl: "http://127.0.0.1:9/checkout", apps: [GUIDE_APP], deliver: (raw, headers, to) => void got.push({ raw, headers, to }) });
    beforeAll(async () => {
      s = await startApp(SANDBOX_ENV, { paypalFetch: fake.fetch });
    });
    afterAll(async () => {
      await s?.app.close();
    });

    it("each endpoint takes its own app's webhooks; the same event on both is processed once", async () => {
      fake.refundEventsOnBoth = true;
      const tab = new Browser(s.base);
      const first = await tab.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday and hold the spot" });
      const id = first.bookings[0].booking_id as string;
      await fetch(first.guide_phone[0].url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "price", total: "80", deposit: "30" }) });
      const service = s.app.service;
      await service.proposeMandate(id);
      const st = await tab.json("/api/state");
      const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
      expect((await tab.json(`/api/mandates/${st.bookings[0].mandate.id}/approve`, { code })).ok).toBe(true);
      const orderId = (await service.createOrder(id)).order_id!;
      fake.approve(orderId);
      await service.captureIfApproved(id);
      await service.offerRefund(first.guide_phone[0].url.split("/o/")[1]);
      await fake.flush();
      const approved = got.find((d) => eventOf(d).event_type === "CHECKOUT.ORDER.APPROVED")!;
      expect(approved.to.clientId).toBe(FAKE_CLIENT_ID);
      expect((await post(s.base, "/webhooks/paypal/guide", approved)).status).toBe(400);
      expect((await post(s.base, "/webhooks/paypal", approved)).status).toBe(200);

      expect(await service.refund(id)).toMatchObject({ status: "refunded" });
      await fake.flush();
      const refunds = got.filter((d) => eventOf(d).event_type === "PAYMENT.CAPTURE.REFUNDED");
      expect(refunds.map((d) => d.to.clientId)).toEqual([GUIDE_APP.clientId, FAKE_CLIENT_ID]);
      const [onGuide, onOperator] = refunds;
      // Each refused on the other endpoint (the other's webhook id), accepted on its own.
      expect((await post(s.base, "/webhooks/paypal", onGuide!)).status).toBe(400);
      expect((await post(s.base, "/webhooks/paypal/guide", onOperator!)).status).toBe(400);
      const answers = await Promise.all([post(s.base, "/webhooks/paypal/guide", onGuide!), post(s.base, "/webhooks/paypal", onOperator!)]);
      expect(answers.map((r) => r.status)).toEqual([200, 200]);
      expect((await Promise.all(answers.map((r) => r.json() as Promise<{ result: string }>))).map((b) => b.result).sort()).toEqual(["duplicate", "logged"]);
      expect(s.app.service.get(id)).toMatchObject({ status: "refunded" });
      const rows = (await tab.json("/api/state")).ledger.filter((e: { kind: string }) => e.kind === "webhook.PAYMENT.CAPTURE.REFUNDED");
      expect(rows).toHaveLength(1);
      expect(s.logs.filter((l) => l.event === "webhook").map((l) => l.endpoint)).toEqual(expect.arrayContaining(["operator", "guide"]));
    });
  });

  it("PAYPAL_GUIDE_WEBHOOK_ID empty: the guide endpoint answers 503 (PayPal retries); the operator's still verifies", async () => {
    const got: Array<{ raw: string; headers: Record<string, string>; to: FakeApp }> = [];
    const fake = new FakePayPal({ apps: [GUIDE_APP], deliver: (raw, headers, to) => void got.push({ raw, headers, to }) });
    const s = await startApp({ ...SANDBOX_ENV, PAYPAL_GUIDE_WEBHOOK_ID: "" }, { paypalFetch: fake.fetch });
    try {
      fake.emitWebhook("PAYMENT.REFUND.FAILED", "refund", { id: "RNOSUCHREFUND0001", status: "FAILED" }, { to: [GUIDE_APP.clientId] });
      await fake.flush();
      expect((await post(s.base, "/webhooks/paypal/guide", got[0]!)).status).toBe(503);
      fake.emitWebhook("PAYMENT.REFUND.FAILED", "refund", { id: "RNOSUCHREFUND0002", status: "FAILED" });
      await fake.flush();
      expect((await post(s.base, "/webhooks/paypal", got[1]!)).status).toBe(200);
    } finally {
      await s.app.close();
    }
  });

  it("fake mode (offline demo): the fake posts each app's webhooks to its endpoint, and the refund's event is logged", async () => {
    const s = await startApp();
    try {
      const tab = new Browser(s.base);
      const first = await tab.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday and hold the spot" });
      const id = first.bookings[0].booking_id as string;
      const service = s.app.service;
      await fetch(first.guide_phone[0].url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "price", total: "80", deposit: "30" }) });
      await service.proposeMandate(id);
      const st = await tab.json("/api/state");
      const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
      await tab.json(`/api/mandates/${st.bookings[0].mandate.id}/approve`, { code });
      s.app.fake!.approve((await service.createOrder(id)).order_id!);
      await service.captureIfApproved(id);
      await service.offerRefund(first.guide_phone[0].url.split("/o/")[1]);
      expect(await service.refund(id)).toMatchObject({ status: "refunded" });
      await s.app.fake!.flush();
      const kinds = (await tab.json("/api/state")).ledger.map((e: { kind: string }) => e.kind);
      expect(kinds).toContain("webhook.PAYMENT.CAPTURE.REFUNDED");
      const endpoints = s.logs.filter((l) => l.event === "webhook").map((l) => [l.endpoint, l.status]);
      expect(endpoints).toEqual(expect.arrayContaining([["operator", 200], ["guide", 200]]));
      expect(endpoints.every(([, status]) => status === 200)).toBe(true);
    } finally {
      await s.app.close();
    }
  });
});
