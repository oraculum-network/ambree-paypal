// Round 10: what the fake PayPal can now model for the refund-evidence tests (DESIGN.md §19). A PayPal that
// doesn't dedupe a repeated PayPal-Request-Id; refund resources without custom_id (only their `up` link to
// the capture); seller_payable_breakdown.total_refunded_amount on refund replies and GETs; and a request
// processed at once whose reply is held.

import { describe, expect, it } from "vitest";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { firstCapture } from "../src/paypal/types.ts";

const GUIDE = { email_address: "guide@business.example" };
const BK = "bk_000000000001";
const TEN = { currency_code: "EUR" as const, value: "10.00" };

async function captured() {
  // The guide's own app: PayPal lets only it refund, and read refunds of, a capture paid to the guide (§21).
  const guideApp = { ...fakeAppFor("GUIDEACCOUNT1"), ownerEmails: [GUIDE.email_address] };
  const fake = new FakePayPal({ apps: [guideApp] });
  const sent: Array<{ event_type: string; resource: Record<string, unknown> }> = [];
  fake.deliver = (raw) => void sent.push(JSON.parse(raw) as { event_type: string; resource: Record<string, unknown> });
  const operator = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
  const o = await operator.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "30.00" }, payee: GUIDE, custom_id: BK }] }, "o1");
  fake.approve(o.id);
  const cap = firstCapture(await operator.captureOrder(o.id, "c1"))!;
  await fake.flush();
  sent.length = 0;
  const client = new PayPalRestClient({ clientId: guideApp.clientId, clientSecret: guideApp.clientSecret, fetch: fake.fetch });
  return { fake, client, captureId: cap.id, sent };
}

const up = (r: { links?: Array<{ rel: string; href: string }> }) => r.links?.find((l) => l.rel === "up")?.href;

describe("the fake: dedupe off", () => {
  it("a repeated PayPal-Request-Id makes another refund instead of replaying the first", async () => {
    const { fake, client, captureId } = await captured();
    fake.dedupe = false;
    const a = await client.refundCapture(captureId, { amount: TEN, custom_id: BK }, "rf1");
    const b = await client.refundCapture(captureId, { amount: TEN, custom_id: BK }, "rf1");
    expect(a.id).not.toBe(b.id);
    expect(fake.refundIds()).toEqual([a.id, b.id]);
    expect(fake.refundedFrom(captureId)).toBe(2000);
    expect(fake.balance(GUIDE)).toBe(1000);
  });

  it("kept: with dedupe on (the default) the same id replays the first reply", async () => {
    const { fake, client, captureId } = await captured();
    const a = await client.refundCapture(captureId, { amount: TEN }, "rf1");
    expect((await client.refundCapture(captureId, { amount: TEN }, "rf1")).id).toBe(a.id);
    expect(fake.refundedFrom(captureId)).toBe(1000);
  });
});

describe("the fake: refunds without custom_id", () => {
  it("the reply, the GET and the webhook carry no custom_id, and name the capture by their up link", async () => {
    const { fake, client, captureId, sent } = await captured();
    fake.refundCustomId = false;
    const r = await client.refundCapture(captureId, { amount: TEN, custom_id: BK }, "rf1");
    const got = await client.getRefund(r.id);
    await fake.flush();
    for (const res of [r, got, sent[0]!.resource as unknown as typeof r]) {
      expect(res).not.toHaveProperty("custom_id");
      expect(up(res)).toMatch(new RegExp(`/v2/payments/captures/${captureId}$`));
    }
    expect(sent.map((e) => e.event_type)).toEqual(["PAYMENT.CAPTURE.REFUNDED"]);
  });

  it("kept: by default they carry the custom_id that was sent", async () => {
    const { client, captureId } = await captured();
    const r = await client.refundCapture(captureId, { amount: TEN, custom_id: BK }, "rf1");
    expect(r.custom_id).toBe(BK);
    expect((await client.getRefund(r.id)).custom_id).toBe(BK);
  });
});

describe("the fake: seller_payable_breakdown.total_refunded_amount", () => {
  it("is the capture's completed refunds when the resource is produced; a PENDING refund isn't in it until it completes", async () => {
    const { fake, client, captureId } = await captured();
    const a = await client.refundCapture(captureId, { amount: TEN }, "rf1");
    expect(a.seller_payable_breakdown?.total_refunded_amount).toEqual({ currency_code: "EUR", value: "10.00" });
    fake.pendNextRefund();
    const b = await client.refundCapture(captureId, { amount: TEN }, "rf2");
    expect(b.seller_payable_breakdown?.total_refunded_amount).toEqual({ currency_code: "EUR", value: "10.00" });
    fake.settleRefund(b.id, "COMPLETED");
    expect((await client.getRefund(b.id)).seller_payable_breakdown?.total_refunded_amount).toEqual({ currency_code: "EUR", value: "20.00" });
    // The GET of the first refund shows the running total too; a replayed reply shows the one first sent.
    expect((await client.getRefund(a.id)).seller_payable_breakdown?.total_refunded_amount?.value).toBe("20.00");
    expect((await client.refundCapture(captureId, { amount: TEN }, "rf1")).seller_payable_breakdown?.total_refunded_amount?.value).toBe("10.00");
  });

  it("refundTotals off: no seller_payable_breakdown at all", async () => {
    const { fake, client, captureId } = await captured();
    fake.refundTotals = false;
    const a = await client.refundCapture(captureId, { amount: TEN }, "rf1");
    expect(a).not.toHaveProperty("seller_payable_breakdown");
    expect(await client.getRefund(a.id)).not.toHaveProperty("seller_payable_breakdown");
  });
});

describe("the fake: replyAfter", () => {
  it("the request is processed at once (money moved, webhook sent), its reply held until released", async () => {
    const { fake, client, captureId, sent } = await captured();
    let release!: () => void;
    fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true, replyAfter: new Promise<void>((r) => (release = r)) });
    let done = false;
    const p = client.refundCapture(captureId, { amount: TEN }, "rf1").then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 0));
    await fake.flush();
    expect(done).toBe(false);
    expect(fake.refundedFrom(captureId)).toBe(1000);
    expect(sent.map((e) => e.event_type)).toEqual(["PAYMENT.CAPTURE.REFUNDED"]);
    release();
    expect((await p).amount).toEqual(TEN);
  });

  it("with dropResponse: processed at once, the reply lost only when released", async () => {
    const { fake, client, captureId } = await captured();
    let release!: () => void;
    fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true, replyAfter: new Promise<void>((r) => (release = r)) });
    fake.failNext({ method: "POST", path: /\/refund$/, status: 0, network: true });
    let err: unknown;
    const p = client.refundCapture(captureId, { amount: TEN }, "rf1").catch((e: unknown) => (err = e));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.refundedFrom(captureId)).toBe(1000);
    expect(err).toBeUndefined();
    release();
    await p;
    expect(err).toMatchObject({ kind: "network", maybeDelivered: true });
  });
});
