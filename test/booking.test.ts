import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/booking/service.ts";
import { SEED_GUIDES, guidesWithPayee, searchGuides } from "../src/guides/seed.ts";
import { MANDATE_TTL_MS } from "../src/mandate/mandate.ts";
import { applyOperatorAction, renderOperatorPage } from "../src/operator/page.ts";
import { makeWorld, tokenOf } from "./helpers/world.ts";

const CONV = "cv_test";

async function priced(w = makeWorld()) {
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" });
  const token = tokenOf(operatorUrl);
  w.service.priceQuote(token, { total: "80", deposit: "30", note: "06:30 at the car park" });
  return { w, id: booking.id, token };
}

async function paid() {
  const { w, id, token } = await priced();
  w.service.proposeMandate(id);
  const code = w.channels.inbox(CONV).at(-1)!.code;
  w.service.approveMandate(w.service.get(id)!.mandate_id!, code);
  const b = await w.service.createOrder(id);
  w.fake.approve(b.order_id!);
  await w.fake.flush();
  await w.fake.flush();
  return { w, id, token };
}

describe("guides", () => {
  it("seeds 5 invented guides, every name marked (demo)", () => {
    expect(SEED_GUIDES).toHaveLength(5);
    for (const g of SEED_GUIDES) {
      expect(g.name).toMatch(/\(demo\)$/);
      expect(g.payee.merchant_id).toMatch(/^[A-Z0-9]{13}$/);
    }
    expect(new Set(SEED_GUIDES.map((g) => g.id)).size).toBe(5);
  });

  it("searches by area, activity and language, ignoring case and accents", () => {
    expect(searchGuides(SEED_GUIDES, { area: "le morne", activity: "hike" }).map((g) => g.id)).toEqual(["g_lantern", "g_quillfeather"]);
    expect(searchGuides(SEED_GUIDES, { area: "Chamarél" }).map((g) => g.id)).toEqual(["g_ebonyleaf"]);
    expect(searchGuides(SEED_GUIDES, { activity: "kayak", language: "fr" }).map((g) => g.id)).toEqual(["g_tidecount"]);
    expect(searchGuides(SEED_GUIDES, { area: "Grand Baie" })).toEqual([]);
  });

  it("one sandbox account can play every guide", () => {
    const p = { merchant_id: "GUIDEACCOUNT1" };
    expect(guidesWithPayee(p).every((g) => g.payee === p)).toBe(true);
    expect(guidesWithPayee(undefined)[0]!.payee).toEqual(SEED_GUIDES[0]!.payee);
  });
});

describe("operator page", () => {
  it("shows the request and a price form; the token is a 256-bit capability", () => {
    const w = makeWorld();
    const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike", note: "<script>x</script>" });
    const token = tokenOf(operatorUrl);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.service.byToken(token)?.id).toBe(booking.id);
    expect(w.service.byToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeUndefined();
    expect(JSON.stringify(w.db.prepare("SELECT * FROM records").all())).not.toContain(token);
    const html = renderOperatorPage(token, booking);
    expect(html).toContain("Lantern Ridge Walks (demo)");
    expect(html).toContain('name="deposit"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x");
  });

  it("pricing freezes and hashes the quote and tells the conversation", async () => {
    const { w, id, token } = await priced();
    const b = w.service.get(id)!;
    expect(b.status).toBe("priced");
    expect(b.quote).toMatchObject({ total: { currency_code: "EUR", value: "80.00" }, deposit: { value: "30.00" }, payee: SEED_GUIDES[0]!.payee });
    expect(b.quote_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.channels.drain(CONV).map((e) => e.type)).toEqual(["guide_priced"]);
    expect(applyOperatorAction(w.service, token, new URLSearchParams({ action: "price", total: "90", deposit: "10" }))).toMatchObject({ ok: false });
    expect(renderOperatorPage(token, b)).toContain("quote hash");
  });

  it.each([
    [{ total: "80", deposit: "90" }, /at most the total/],
    [{ total: "abc", deposit: "10" }, /amounts like/],
    [{ total: "0", deposit: "0" }, /more than 0/],
    [{ total: "5000", deposit: "10" }, /caps/],
  ])("refuses a bad price %j", (form, msg) => {
    const w = makeWorld();
    const { operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" });
    const r = applyOperatorAction(w.service, tokenOf(operatorUrl), new URLSearchParams({ action: "price", ...form }));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(msg);
  });

  it("the guide can decline", () => {
    const w = makeWorld();
    const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_quillfeather", date: "2026-11-05", party_size: 1, activity: "hike" });
    expect(applyOperatorAction(w.service, tokenOf(operatorUrl), new URLSearchParams({ action: "decline" })).ok).toBe(true);
    expect(w.service.get(booking.id)!.status).toBe("declined");
    expect(() => w.service.proposeMandate(booking.id)).toThrow(ServiceError);
  });

  it("refuses unknown guides, bad dates and party sizes", () => {
    const w = makeWorld();
    const base = { conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" };
    expect(() => w.service.requestQuote({ ...base, guide_id: "g_nope" })).toThrow(/No guide/);
    expect(() => w.service.requestQuote({ ...base, date: "Thursday" })).toThrow(/YYYY-MM-DD/);
    expect(() => w.service.requestQuote({ ...base, party_size: 0 })).toThrow(/1 to 12/);
  });
});

describe("mandate → order → capture → webhooks → ledger", () => {
  it("the happy path pays the guide and every step is in a valid chain", async () => {
    const { w, id } = await paid();
    const b = w.service.get(id)!;
    expect(b.status).toBe("captured");
    expect(b.captured).toEqual({ currency_code: "EUR", value: "30.00" });
    expect(w.fake.balance(SEED_GUIDES[0]!.payee)).toBe(3000);
    expect(w.fake.balance({ email_address: "app-owner" } as never)).toBe(0);
    const order = w.fake.order(b.order_id!)!;
    expect(order.purchase_units![0]!.payee).toEqual(SEED_GUIDES[0]!.payee);
    expect(w.ledger.list(id).map((e) => e.kind)).toEqual([
      "quote.requested",
      "quote.priced",
      "mandate.proposed",
      "mandate.approved",
      "order.created",
      "webhook.CHECKOUT.ORDER.APPROVED",
      "capture.completed",
      "webhook.PAYMENT.CAPTURE.COMPLETED",
    ]);
    expect(w.webhookResults.map((r) => r.result)).toEqual(["logged", "logged"]);
    expect(w.ledger.verify().ok).toBe(true);
  });

  it("the order uses the mandate nonce as PayPal-Request-Id and the guide's payee", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const code = w.channels.inbox(CONV).at(-1)!.code;
    const m = w.service.mandateView(w.service.get(id)!)!;
    w.service.approveMandate(m.id, code);
    await w.service.createOrder(id);
    const create = w.fake.calls.find((c) => c.path === "/v2/checkout/orders")!;
    expect(create.requestId).toBe(m.nonce);
    expect(w.mandates.get(m.id)!.status).toBe("used");
    // A second create returns the same order, no new PayPal call.
    const again = await w.service.createOrder(id);
    expect(again.order_id).toBe(w.service.get(id)!.order_id);
    expect(w.fake.calls.filter((c) => c.path === "/v2/checkout/orders")).toHaveLength(1);
  });

  it("no order without an approved mandate", async () => {
    const { w, id } = await priced();
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "no_mandate" });
    w.service.proposeMandate(id);
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "no_mandate" });
    expect(w.fake.calls.filter((c) => c.path === "/v2/checkout/orders")).toHaveLength(0);
  });

  it("a wrong code is logged and refused; an expired mandate can't pay", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    expect(() => w.service.approveMandate(mandate_id, code === "000000" ? "111111" : "000000")).toThrow(/not right/);
    expect(w.ledger.list(id).at(-1)!.kind).toBe("mandate.rejected");
    w.service.approveMandate(mandate_id, code);
    w.advance(MANDATE_TTL_MS + 1);
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "expired" });
    expect(w.ledger.list(id).at(-1)).toMatchObject({ kind: "order.refused", data: { reason: "expired" } });
  });

  it("a guide whose payee changed after approval is refused (payee pinning)", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    w.service.approveMandate(mandate_id, code);
    (w.service.guides as unknown as Array<{ id: string; payee: unknown }>).find((g) => g.id === "g_lantern")!.payee = { merchant_id: "SOMEONEELSE01" };
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ code: "payee_mismatch" });
  });

  it("a stale mandate can't be approved after a newer one", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const first = w.channels.inbox(CONV).at(-1)!;
    w.service.proposeMandate(id);
    expect(() => w.service.approveMandate(first.mandate_id, first.code)).toThrow(/newer mandate/);
  });

  it("an ambiguous create failure keeps the mandate and retries with the same nonce", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    w.service.approveMandate(mandate_id, code);
    w.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 503, body: { name: "SERVICE_UNAVAILABLE" } });
    w.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 503, body: { name: "SERVICE_UNAVAILABLE" } });
    await expect(w.service.createOrder(id)).rejects.toMatchObject({ status: 503 });
    const b = await w.service.createOrder(id);
    expect(b.status).toBe("order_created");
    const ids = w.fake.calls.filter((c) => c.path === "/v2/checkout/orders").map((c) => c.requestId);
    expect(new Set(ids).size).toBe(1);
  });

  it("capture waits for the buyer, and is idempotent", async () => {
    const { w, id } = await priced();
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    w.service.approveMandate(mandate_id, code);
    const b = await w.service.createOrder(id);
    expect(await w.service.captureIfApproved(id)).toMatchObject({ captured: false, order_status: "PAYER_ACTION_REQUIRED" });
    w.fake.deliver = undefined;
    w.fake.approve(b.order_id!);
    const [x, y] = await Promise.all([w.service.captureIfApproved(id), w.service.captureIfApproved(id)]);
    expect(x.captured && y.captured).toBe(true);
    expect(w.ledger.list(id).filter((e) => e.kind === "capture.completed")).toHaveLength(1);
    expect(w.fake.balance(SEED_GUIDES[0]!.payee)).toBe(3000);
  });
});

describe("webhook endpoint rules", () => {
  it("refuses unsigned, tampered and malformed deliveries; dedupes redeliveries", async () => {
    const w = makeWorld();
    const got: Array<{ raw: string; headers: Record<string, string> }> = [];
    const { id } = await priced(w);
    w.fake.deliver = (raw, headers) => void got.push({ raw, headers });
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    w.service.approveMandate(mandate_id, code);
    const b = await w.service.createOrder(id);
    w.fake.approve(b.order_id!);
    await w.fake.flush();
    const { raw, headers } = got[0]!;
    expect(await w.service.handleWebhook(raw, {})).toMatchObject({ status: 400 });
    expect(await w.service.handleWebhook("{", headers)).toMatchObject({ status: 400 });
    expect(await w.service.handleWebhook(raw.replace("APPROVED", "VOIDED"), headers)).toMatchObject({ status: 400, result: "signature not verified" });
    expect(await w.service.handleWebhook(raw, headers)).toMatchObject({ status: 200, result: "logged" });
    expect(await w.service.handleWebhook(raw, headers)).toMatchObject({ status: 200, result: "duplicate" });
    expect(w.service.get(id)!.status).toBe("captured");
  });

  it("asks PayPal to retry when verification itself fails", async () => {
    const w = makeWorld();
    const got: Array<{ raw: string; headers: Record<string, string> }> = [];
    w.fake.deliver = (raw, headers) => void got.push({ raw, headers });
    const { id } = await priced(w);
    w.service.proposeMandate(id);
    const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
    w.service.approveMandate(mandate_id, code);
    w.fake.approve((await w.service.createOrder(id)).order_id!);
    await w.fake.flush();
    w.fake.failNext({ path: /verify-webhook-signature/, status: 500, body: {} });
    w.fake.failNext({ path: /verify-webhook-signature/, status: 500, body: {} });
    expect(await w.service.handleWebhook(got[0]!.raw, got[0]!.headers)).toMatchObject({ status: 503 });
  });
});

describe("cyclone → reschedule or refund", () => {
  it("no refund without a reason", async () => {
    const { w, id } = await paid();
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
  });

  it("a cyclone warning allows a partial then a full refund", async () => {
    const { w, id } = await paid();
    w.weather.raise({ id: "TC-1", name: "Cyclone Demo-1", level: "orange", from: "2026-11-04", to: "2026-11-06", summary: "" });
    expect(await w.service.announceCyclone(CONV)).toBe(1);
    expect((await w.service.weatherFor(id)).explanation).toMatch(/mountain trails are unsafe/);
    await expect(w.service.refund(id, "40.00")).rejects.toMatchObject({ code: "bad_amount" });
    expect((await w.service.refund(id, "10.00")).status).toBe("partially_refunded");
    expect((await w.service.refund(id)).status).toBe("refunded");
    expect(w.fake.balance(SEED_GUIDES[0]!.payee)).toBe(0);
    await w.fake.flush();
    const kinds = w.ledger.list(id).map((e) => e.kind);
    expect(kinds.filter((k) => k === "refund.completed")).toHaveLength(2);
    expect(kinds.filter((k) => k === "webhook.PAYMENT.CAPTURE.REFUNDED")).toHaveLength(2);
    expect(w.ledger.verify().ok).toBe(true);
  });

  it("a green alert alone does not allow a refund", async () => {
    const { w, id } = await paid();
    w.weather.raise({ id: "TC-2", name: "Far storm", level: "green", from: "2026-11-05", to: "2026-11-05", summary: "" });
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_not_allowed" });
  });

  it("the guide accepts a reschedule: the date moves, no money moves", async () => {
    const { w, id, token } = await paid();
    w.service.proposeReschedule(id, "2026-11-07");
    expect(renderOperatorPage(token, w.service.get(id)!)).toContain("Move the trip?");
    applyOperatorAction(w.service, token, new URLSearchParams({ action: "accept_reschedule" }));
    const b = w.service.get(id)!;
    expect(b.date).toBe("2026-11-07");
    expect(b.status).toBe("captured");
    expect(w.fake.balance(SEED_GUIDES[0]!.payee)).toBe(3000);
  });

  it("the guide declines the reschedule: a full refund is allowed", async () => {
    const { w, id, token } = await paid();
    w.service.proposeReschedule(id, "2026-11-07");
    expect(() => w.service.proposeReschedule(id, "2026-11-08")).toThrow(/already waiting/);
    applyOperatorAction(w.service, token, new URLSearchParams({ action: "decline_reschedule" }));
    expect(await w.service.refundReason(w.service.get(id)!)).toBe("the guide declined the reschedule");
    expect((await w.service.refund(id)).status).toBe("refunded");
    const refundCall = w.fake.calls.find((c) => c.path.endsWith("/refund"))!;
    expect(refundCall.requestId).toBe(`refund-${id}-1`);
  });

  it("the guide can offer a refund", async () => {
    const { w, id, token } = await paid();
    applyOperatorAction(w.service, token, new URLSearchParams({ action: "offer_refund" }));
    expect((await w.service.refund(id, "30.00")).status).toBe("refunded");
  });

  it("summaries never carry the nonce or operator token", async () => {
    const { w, id, token } = await paid();
    const m = w.mandates.get(w.service.get(id)!.mandate_id!)!;
    const s = JSON.stringify(w.service.summary(w.service.get(id)!));
    expect(s).not.toContain(m.nonce);
    expect(s).not.toContain(token);
    expect(s).not.toContain("step_up");
  });
});
