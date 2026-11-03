// D5 (DESIGN.md §21): the fake models PayPal's permission split, as the sandbox showed it on 3 Nov, so a test
// catches a refund sent through the wrong app. The fake has several apps (a client id and secret each, and an
// owner merchant id); the token says which app calls. An order with no payee is paid to the calling app's
// owner. Only the app owned by a capture's payee may refund it or read its refunds (403 NOT_AUTHORIZED /
// PERMISSION_DENIED otherwise, nothing refunded). The order's creator and the payee may read the capture.

import { describe, expect, it } from "vitest";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { firstCapture } from "../src/paypal/types.ts";

const GUIDE = "GUIDEACCOUNT1";
const eur = (value: string) => ({ currency_code: "EUR" as const, value });

function world() {
  const fake = new FakePayPal({ apps: [fakeAppFor(GUIDE), { ...fakeAppFor("STRANGER00001"), ownerEmails: ["stranger@business.example"] }] });
  const client = (clientId: string, clientSecret: string) => new PayPalRestClient({ clientId, clientSecret, fetch: fake.fetch });
  const operator = client(fake.clientId, fake.clientSecret);
  const guideApp = fakeAppFor(GUIDE);
  const guide = client(guideApp.clientId, guideApp.clientSecret);
  const strangerApp = fakeAppFor("STRANGER00001");
  const stranger = client(strangerApp.clientId, strangerApp.clientSecret);
  return { fake, operator, guide, stranger };
}

/** A 30.00 capture paid to `payee`, created and captured by the operator's app. */
async function captured(w: ReturnType<typeof world>, payee: { merchant_id: string } | { email_address: string } = { merchant_id: GUIDE }) {
  const o = await w.operator.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("30.00"), payee, custom_id: "bk_000000000001" }] }, `o-${Math.random()}`);
  w.fake.approve(o.id);
  return firstCapture(await w.operator.captureOrder(o.id, `c-${o.id}`))!.id;
}

const denied = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(PayPalError);
  expect(e).toMatchObject({ status: 403, code: "NOT_AUTHORIZED", issue: "PERMISSION_DENIED", maybeDelivered: false });
};

describe("D5: the fake's apps", () => {
  it("the token says which app calls: an order with no payee is paid to that app's owner", async () => {
    const w = world();
    const mine = await w.operator.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("1.00") }] }, "n1");
    const theirs = await w.guide.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("1.00") }] }, "n1");
    expect(mine.purchase_units![0]!.payee).toEqual({ merchant_id: "AMBREEOPER001" });
    expect(theirs.purchase_units![0]!.payee).toEqual({ merchant_id: GUIDE });
    // The same PayPal-Request-Id from another app is another request (idempotency is per app).
    expect(theirs.id).not.toBe(mine.id);
    expect((await w.guide.getAppOwner()).merchant_id).toBe(GUIDE);
    expect(w.fake.apps().map((a) => [a.clientId, a.ownerMerchantId])).toEqual([
      [w.fake.clientId, "AMBREEOPER001"],
      [fakeAppFor(GUIDE).clientId, GUIDE],
      [fakeAppFor("STRANGER00001").clientId, "STRANGER00001"],
    ]);
    expect(JSON.stringify(w.fake.apps())).not.toContain(fakeAppFor(GUIDE).clientSecret);
  });

  it("unknown credentials get no token", async () => {
    const w = world();
    const bad = new PayPalRestClient({ clientId: fakeAppFor(GUIDE).clientId, clientSecret: "not-the-secret", fetch: w.fake.fetch });
    await expect(bad.getAppOwner()).rejects.toMatchObject({ status: 401, kind: "auth" });
    expect(() => w.fake.addApp(fakeAppFor(GUIDE))).toThrow(/already/);
  });
});

describe("D5: refunds only by the payee's own app", () => {
  it("the operator's app: 403 NOT_AUTHORIZED / PERMISSION_DENIED, nothing refunded, no event", async () => {
    const w = world();
    const captureId = await captured(w);
    await w.fake.flush();
    const sent = w.fake.sentWebhooks.length;
    await denied(w.operator.refundCapture(captureId, { amount: eur("10.00") }, "rf1"));
    await denied(w.stranger.refundCapture(captureId, {}, "rf2"));
    expect(w.fake.refundedFrom(captureId)).toBe(0);
    expect(w.fake.balance({ merchant_id: GUIDE })).toBe(3000);
    expect(w.fake.refundIds()).toEqual([]);
    expect(w.fake.sentWebhooks.length).toBe(sent);
  });

  it("the payee's own app refunds; then only it may read the refund", async () => {
    const w = world();
    const captureId = await captured(w);
    // The operator's refused attempt under a request id doesn't poison the guide's under the same id.
    await denied(w.operator.refundCapture(captureId, { amount: eur("10.00") }, "rf1"));
    const r = await w.guide.refundCapture(captureId, { amount: eur("10.00") }, "rf1");
    expect(r).toMatchObject({ status: "COMPLETED", amount: eur("10.00") });
    expect(w.fake.refundedFrom(captureId)).toBe(1000);
    expect((await w.guide.getRefund(r.id)).id).toBe(r.id);
    await denied(w.operator.getRefund(r.id));
    await denied(w.stranger.getRefund(r.id));
    // An unknown refund is a 404, whoever asks.
    await expect(w.operator.getRefund("RNOSUCHREFUND0001")).rejects.toMatchObject({ status: 404 });
  });

  it("a payee given by email belongs to the app whose owner lists that email", async () => {
    const w = world();
    const captureId = await captured(w, { email_address: "Stranger@Business.example" });
    await denied(w.guide.refundCapture(captureId, {}, "rf1"));
    expect((await w.stranger.refundCapture(captureId, {}, "rf1")).status).toBe("COMPLETED");
  });

  it("the capture: its order's creator and its payee may read it; another app may not", async () => {
    const w = world();
    const captureId = await captured(w);
    await w.guide.refundCapture(captureId, { amount: eur("10.00") }, "rf1");
    for (const c of [w.operator, w.guide]) {
      const cap = await c.getCapture(captureId);
      expect(cap).toMatchObject({ id: captureId, status: "PARTIALLY_REFUNDED", amount: eur("30.00") });
      expect(cap.links!.map((l) => l.rel)).toEqual(["self", "refund", "up"]);
    }
    await denied(w.stranger.getCapture(captureId));
  });
});
