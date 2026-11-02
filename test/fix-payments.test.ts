// Findings 2-7: payee vs operator, order validation before capture, create failures vs expiry,
// pending captures/refunds, refund idempotency, webhook processing states.

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import { MANDATE_TTL_MS } from "../src/mandate/mandate.ts";
import type { Payee } from "../src/paypal/types.ts";
import { createApp } from "../src/app.ts";
import { makeWorld, tokenOf } from "./helpers/world.ts";

const CONV = "cv_payments_001";
const GUIDE = SEED_GUIDES[0]!.payee;

async function approvedMandate(w = makeWorld()) {
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" });
  await w.service.priceQuote(tokenOf(operatorUrl), { total: "80", deposit: "30" });
  await w.service.proposeMandate(booking.id);
  const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
  await w.service.approveMandate(mandate_id, code);
  return { w, id: booking.id, token: tokenOf(operatorUrl) };
}

async function ordered(w = makeWorld()) {
  const r = await approvedMandate(w);
  w.fake.deliver = undefined;
  const b = await w.service.createOrder(r.id);
  return { ...r, orderId: b.order_id! };
}

async function paid() {
  const r = await ordered();
  r.w.fake.approve(r.orderId);
  await r.w.service.captureIfApproved(r.id);
  return r;
}

function orderBody(id: string, orderId: string, capture: { id: string; status: string; value?: string; currency?: string }) {
  return {
    id: orderId,
    status: "COMPLETED",
    purchase_units: [
      {
        reference_id: id,
        custom_id: id,
        amount: { currency_code: "EUR", value: "30.00" },
        payee: GUIDE,
        payments: { captures: [{ id: capture.id, status: capture.status, amount: { currency_code: capture.currency ?? "EUR", value: capture.value ?? "30.00" }, custom_id: id }] },
      },
    ],
  };
}

describe("finding 2: the operator is never the payee", () => {
  const SANDBOX = { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" };
  it("sandbox mode needs the operator's identity", () => {
    expect(() => loadConfig({ ...SANDBOX, PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1" })).toThrow(/PAYPAL_OPERATOR_MERCHANT_ID/);
  });

  it("refuses a guide payee equal to the operator (merchant id)", () => {
    expect(() => loadConfig({ ...SANDBOX, PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "ABCDEFGH12345", PAYPAL_OPERATOR_MERCHANT_ID: "ABCDEFGH12345" })).toThrow(ConfigError);
    const ok = loadConfig({ ...SANDBOX, PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1", PAYPAL_OPERATOR_MERCHANT_ID: "OPERATORACCT1" });
    expect(ok.operatorPayees).toEqual([{ merchant_id: "OPERATORACCT1" }]);
  });

  it("the app refuses to start when a seed guide pays the operator", () => {
    const config = loadConfig({ PAYPAL_OPERATOR_MERCHANT_ID: GUIDE.merchant_id! });
    expect(() => createApp({ config })).toThrow(/operator/);
  });

  it("no order or capture goes to an operator account", async () => {
    const w = makeWorld({ operatorPayees: [GUIDE as Payee] });
    const { id } = await approvedMandate(w);
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "payee_is_operator" });
    expect(w.fake.calls.filter((c) => c.path === "/v2/checkout/orders")).toHaveLength(0);
  });
});

describe("finding 3: the fetched order is checked before capture, the capture after", () => {
  it("an order changed out of band is not captured", async () => {
    const { w, id, orderId } = await ordered();
    const other = { merchant_id: "SOMEONEELSE01" };
    w.fake.mutateOrder(orderId, (o) => {
      o.purchase_units![0]!.amount = { currency_code: "USD", value: "40.00" };
      o.purchase_units![0]!.payee = other;
    });
    w.fake.approve(orderId);
    await expect(w.service.captureIfApproved(id)).rejects.toMatchObject({ code: "order_mismatch" });
    expect(w.fake.balance(other)).toBe(0);
    expect(w.fake.calls.filter((c) => c.path.endsWith("/capture"))).toHaveLength(0);
    expect(w.ledger.list(id).at(-1)!.kind).toBe("order.mismatch");
  });

  it("a capture whose amount differs from the mandate is flagged, not paid", async () => {
    const { w, id, orderId } = await ordered();
    w.fake.approve(orderId);
    w.fake.failNext({ method: "POST", path: /\/capture$/, status: 201, body: orderBody(id, orderId, { id: "CAPX0000000000001", status: "COMPLETED", currency: "USD", value: "40.00" }) });
    const r = await w.service.captureIfApproved(id);
    expect(r.captured).toBe(false);
    expect(w.service.get(id)!.status).toBe("needs_review");
    expect(w.channels.drain(CONV).some((e) => e.type === "paid")).toBe(false);
    expect(w.ledger.list(id).some((e) => e.kind === "capture.reconcile_failed")).toBe(true);
  });
});

describe("finding 4: a failed create can't outlive the mandate", () => {
  it("a definitive rejection needs a fresh mandate, even before expiry", async () => {
    const { w, id } = await approvedMandate();
    w.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED" }] } });
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ issue: "PAYEE_ACCOUNT_RESTRICTED" });
    w.advance(MANDATE_TTL_MS + 1);
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "no_mandate" });
    expect(w.fake.calls.filter((c) => c.path === "/v2/checkout/orders" && c.status === 201)).toHaveLength(0);
    expect(w.service.get(id)!.status).toBe("priced");
    expect((await w.service.proposeMandate(id)).status).toBe("proposed");
  });

  it("an ambiguous failure may be retried with the same nonce before expiry, never after", async () => {
    const a = await approvedMandate();
    for (let i = 0; i < 2; i++) a.w.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    await expect(a.w.service.createOrder(a.id)).rejects.toMatchObject({ kind: "network" });
    expect((await a.w.service.createOrder(a.id)).status).toBe("order_created");

    const b = await approvedMandate();
    for (let i = 0; i < 2; i++) b.w.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 0, network: true });
    await expect(b.w.service.createOrder(b.id)).rejects.toMatchObject({ kind: "network" });
    b.w.advance(MANDATE_TTL_MS + 1);
    await expect(b.w.service.createOrder(b.id)).rejects.toMatchObject({ code: "expired" });
    expect(b.w.fake.calls.filter((c) => c.path === "/v2/checkout/orders" && c.status === 201)).toHaveLength(0);
    expect(b.w.service.get(b.id)!.status).toBe("priced");
  });
});

describe("finding 5: pending is not paid", () => {
  it("a PENDING capture is not reported as paid until a GET shows COMPLETED", async () => {
    const { w, id, orderId } = await ordered();
    w.fake.approve(orderId);
    w.fake.failNext({ method: "POST", path: /\/capture$/, status: 201, body: orderBody(id, orderId, { id: "CAPP0000000000001", status: "PENDING" }) });
    expect(await w.service.captureIfApproved(id)).toMatchObject({ captured: false });
    expect(w.service.get(id)!.status).toBe("capture_pending");
    expect(w.channels.drain(CONV).some((e) => e.type === "paid")).toBe(false);
    w.fake.failNext({ method: "GET", path: /^\/v2\/checkout\/orders\//, status: 200, body: orderBody(id, orderId, { id: "CAPP0000000000001", status: "COMPLETED" }) });
    expect(await w.service.captureIfApproved(id)).toMatchObject({ captured: true });
    expect(w.service.get(id)!.status).toBe("captured");
    expect(w.channels.drain(CONV).some((e) => e.type === "paid")).toBe(true);
  });

  it("a PENDING refund is reserved but not counted until COMPLETED", async () => {
    const { w, id, token } = await paid();
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000001", status: "PENDING", amount: { currency_code: "EUR", value: "30.00" } } });
    const b = await w.service.refund(id);
    expect(b.refunded_minor).toBe(0);
    expect(b.status).toBe("captured");
    expect(w.channels.drain(CONV).some((e) => e.type === "refunded")).toBe(false);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "bad_amount" });
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000001", status: "COMPLETED", amount: { currency_code: "EUR", value: "30.00" } } });
    const done = await w.service.refreshRefunds(id);
    expect(done.refunded_minor).toBe(3000);
    expect(done.status).toBe("refunded");
  });
});

describe("finding 6: a refund retry resends the same operation", () => {
  it("a lost reply is retried unchanged, whatever amount the second call asks", async () => {
    const { w, id, token } = await paid();
    await w.service.offerRefund(token);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id, "10.00")).rejects.toMatchObject({ kind: "network" });
    expect(w.fake.balance(GUIDE)).toBe(2000);
    const b = await w.service.refund(id, "20.00");
    expect(b.refunded_minor).toBe(1000);
    expect(w.fake.balance(GUIDE)).toBe(2000);
    const keys = w.fake.calls.filter((c) => c.path.endsWith("/refund")).map((c) => c.requestId);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("finding 7: a webhook whose processing failed is processed on redelivery", () => {
  it("a failed capture during CHECKOUT.ORDER.APPROVED is retried on redelivery", async () => {
    const { w, id, orderId } = await ordered();
    const got: Array<{ raw: string; headers: Record<string, string> }> = [];
    w.fake.deliver = (raw, headers) => void got.push({ raw, headers });
    w.fake.approve(orderId);
    await w.fake.flush();
    w.fake.failNext({ method: "POST", path: /\/capture$/, status: 500, body: {} });
    w.fake.failNext({ method: "POST", path: /\/capture$/, status: 500, body: {} });
    expect(await w.service.handleWebhook(got[0]!.raw, got[0]!.headers)).toMatchObject({ status: 500 });
    expect(w.service.get(id)!.status).toBe("order_created");
    expect(await w.service.handleWebhook(got[0]!.raw, got[0]!.headers)).toMatchObject({ status: 200 });
    expect(w.service.get(id)!.status).toBe("captured");
    expect(await w.service.handleWebhook(got[0]!.raw, got[0]!.headers)).toMatchObject({ status: 200, result: "duplicate" });
    expect(w.ledger.list(id).filter((e) => e.kind === "webhook.CHECKOUT.ORDER.APPROVED")).toHaveLength(1);
  });
});
