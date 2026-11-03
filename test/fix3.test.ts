// Round 3: a refund under review blocks the booking; the operator's merchant id is confirmed with PayPal.

import { describe, expect, it } from "vitest";
import { identityRow } from "../scripts/spike.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FakePayPal } from "../src/paypal/fake.ts";
import { makeWorld, tokenOf } from "./helpers/world.ts";

const CONV = "cv_fix3_000001";

async function paidWithOffer() {
  const w = makeWorld();
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" });
  const token = tokenOf(operatorUrl);
  await w.service.priceQuote(token, { total: "80", deposit: "30" });
  await w.service.proposeMandate(booking.id);
  const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
  await w.service.approveMandate(mandate_id, code);
  w.fake.deliver = undefined;
  const b = await w.service.createOrder(booking.id);
  w.fake.approve(b.order_id!);
  await w.service.captureIfApproved(booking.id);
  await w.service.offerRefund(token);
  return { w, id: booking.id };
}

const pendingRefund = (id: string) => ({ method: "POST", path: /\/refund$/, status: 201, body: { id, status: "PENDING", amount: { currency_code: "EUR", value: "10.00" } } });
const gotRefund = (id: string, currency: string) => ({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id, status: "COMPLETED", amount: { currency_code: currency, value: "10.00" } } });

describe("round 3 #1: needs_review is never overwritten", () => {
  it("a later COMPLETED refund keeps the booking in review and new refunds are refused", async () => {
    const { w, id } = await paidWithOffer();
    w.fake.failNext(pendingRefund("RONE000000000001"));
    await w.service.refund(id, "10.00");
    w.fake.failNext(pendingRefund("RTWO000000000002"));
    await w.service.refund(id, "10.00");
    w.fake.failNext(gotRefund("RONE000000000001", "USD"));
    w.fake.failNext(gotRefund("RTWO000000000002", "EUR"));
    const b = await w.service.refreshRefunds(id);
    expect(b.refund_ops.map((o) => o.status)).toEqual(["needs_review", "completed"]);
    expect(b.status).toBe("needs_review");
    await expect(w.service.refund(id, "5.00")).rejects.toMatchObject({ code: "refund_under_review" });
  });

  it("a retry of an unresolved send is refused while another refund is in review", async () => {
    const { w, id } = await paidWithOffer();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RBAD000000000009", status: "COMPLETED" } });
    await w.service.refund(id, "10.00");
    // Simulate an op left in "sending" (e.g. a crash mid-send) next to the one in review.
    const cur = w.service.get(id)!;
    w.db.prepare("UPDATE records SET json = ? WHERE kind = 'booking' AND id = ?").run(
      JSON.stringify({ ...cur, refund_ops: [...cur.refund_ops, { n: 2, request_id: `refund-${id}-2`, amount_minor: 500, full: false, reason: "x", status: "sending" }] }),
      id,
    );
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "refund_under_review" });
    expect(w.fake.calls.filter((c) => c.path.endsWith("/refund"))).toHaveLength(1);
  });
});

describe("round 3 #2: the operator's merchant id is confirmed with PayPal", () => {
  // Since the spike (S11 answered no; DESIGN.md §21 D3): the owner is the payee PayPal echoes for an order with no payee.
  it("the client asks PayPal who owns the app (the payee echo of a probe order with no payee)", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1" });
    const client = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
    const who = await client.getAppOwner();
    expect(who.merchant_id).toBe("OWNERACCOUNT1");
    expect(fake.calls.some((c) => c.method === "POST" && c.path === "/v2/checkout/orders")).toBe(true);
  });

  it("refuses to start when PayPal's owner differs from PAYPAL_OPERATOR_MERCHANT_ID", async () => {
    const app = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }), fakeOwnerMerchantId: "LANTERNRIDGE1" });
    let started = false;
    try {
      await app.listen();
      started = true;
    } catch (e) {
      expect(String(e)).toMatch(/operator/);
    } finally {
      await app.close().catch(() => undefined);
    }
    expect(started).toBe(false);
  });

  it("starts when they match, and says the identity is confirmed", async () => {
    const app = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }) });
    const port = await app.listen();
    try {
      const h = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>;
      expect(h.operator_identity).toBe("confirmed");
    } finally {
      await app.close();
    }
  });

  it("the spike prints the identity PayPal returns, never a token", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1" });
    const client = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
    const row = await identityRow(client);
    expect(row.note).toContain("merchant_id OWNERACCOUNT1");
    expect(row.note).not.toMatch(/A21AA|Bearer/);
  });
});
