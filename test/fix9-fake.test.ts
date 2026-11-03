// Round 9: what the fake PayPal can now model for the refund-outcome tests. A refund PayPal creates PENDING
// and settles later (COMPLETED or FAILED, with its webhook); a 5xx after PayPal processed the request; a
// reply held until the test releases it.

import { describe, expect, it } from "vitest";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { firstCapture } from "../src/paypal/types.ts";

const GUIDE = { email_address: "guide@business.example" };

async function captured() {
  // The guide's own app: PayPal lets only it refund, and read refunds of, a capture paid to the guide (§21).
  const guideApp = { ...fakeAppFor("GUIDEACCOUNT1"), ownerEmails: [GUIDE.email_address] };
  const fake = new FakePayPal({ apps: [guideApp] });
  const sent: Array<{ event_type: string; resource: Record<string, unknown> }> = [];
  fake.deliver = (raw) => void sent.push(JSON.parse(raw) as { event_type: string; resource: Record<string, unknown> });
  const operator = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
  const o = await operator.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "EUR", value: "30.00" }, payee: GUIDE, custom_id: "bk_000000000001" }] }, "o1");
  fake.approve(o.id);
  const cap = firstCapture(await operator.captureOrder(o.id, "c1"))!;
  await fake.flush();
  sent.length = 0;
  const client = new PayPalRestClient({ clientId: guideApp.clientId, clientSecret: guideApp.clientSecret, fetch: fake.fetch });
  return { fake, client, captureId: cap.id, sent };
}

describe("the fake: a refund PayPal creates PENDING and settles later", () => {
  it("PENDING holds the amount on the capture, moves no money and sends no webhook; COMPLETED then moves it", async () => {
    const { fake, client, captureId, sent } = await captured();
    fake.pendNextRefund();
    const r = await client.refundCapture(captureId, { custom_id: "bk_000000000001" }, "rf1");
    expect(r.status).toBe("PENDING");
    expect(fake.balance(GUIDE)).toBe(3000);
    expect(fake.refundedFrom(captureId)).toBe(0);
    expect((await client.refundCapture(captureId, {}, "rf2").catch((e: PayPalError) => e)) as PayPalError).toMatchObject({ issue: "CAPTURE_FULLY_REFUNDED" });
    await fake.flush();
    expect(sent).toEqual([]);
    fake.settleRefund(r.id, "COMPLETED");
    await fake.flush();
    expect(fake.balance(GUIDE)).toBe(0);
    expect(fake.refundedFrom(captureId)).toBe(3000);
    expect((await client.getRefund(r.id)).status).toBe("COMPLETED");
    expect(sent.map((e) => [e.event_type, e.resource.status, e.resource.custom_id])).toEqual([["PAYMENT.CAPTURE.REFUNDED", "COMPLETED", "bk_000000000001"]]);
    // The same request id still replays the first reply.
    expect((await client.refundCapture(captureId, {}, "rf1")).status).toBe("PENDING");
  });

  it("FAILED releases what it held (a new refund can go out) and sends PAYMENT.REFUND.FAILED", async () => {
    const { fake, client, captureId, sent } = await captured();
    fake.pendNextRefund();
    const r = await client.refundCapture(captureId, { amount: { currency_code: "EUR", value: "10.00" }, custom_id: "bk_000000000001" }, "rf1");
    fake.settleRefund(r.id, "FAILED");
    await fake.flush();
    expect(fake.balance(GUIDE)).toBe(3000);
    expect((await client.getRefund(r.id)).status).toBe("FAILED");
    expect(sent.map((e) => [e.event_type, e.resource.status, e.resource.id])).toEqual([["PAYMENT.REFUND.FAILED", "FAILED", r.id]]);
    expect((await client.refundCapture(captureId, {}, "rf2")).amount).toEqual({ currency_code: "EUR", value: "30.00" });
  });
});

describe("the fake: a 5xx after PayPal processed the request, and a held reply", () => {
  it("dropResponse with a 5xx: the refund was made, the client sees the 5xx; its retry replays the first reply", async () => {
    const { fake, client, captureId } = await captured();
    fake.failNext({ method: "POST", path: /\/refund$/, status: 503, dropResponse: true });
    const r = await client.refundCapture(captureId, {}, "rf1");
    expect(r.status).toBe("COMPLETED");
    expect(fake.balance(GUIDE)).toBe(0);
    expect(fake.calls.filter((c) => c.path.endsWith("/refund")).map((c) => c.status)).toEqual([201, 201]);
  });

  it("wait holds the request until released; pass answers it normally", async () => {
    const { fake, client, captureId } = await captured();
    let release!: () => void;
    fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true, wait: new Promise<void>((r) => (release = r)) });
    let done = false;
    const p = client.refundCapture(captureId, {}, "rf1").then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    expect(fake.balance(GUIDE)).toBe(3000);
    release();
    expect((await p).status).toBe("COMPLETED");
    expect(fake.balance(GUIDE)).toBe(0);
  });
});
