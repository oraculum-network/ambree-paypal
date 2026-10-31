// Round 2, #2: accounts are identified by merchant id only (no email aliases).

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import { makeWorld, tokenOf } from "./helpers/world.ts";

const SANDBOX = { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" };
const CONV = "cv_payee2_00001";

async function ordered() {
  const w = makeWorld();
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" });
  w.service.priceQuote(tokenOf(operatorUrl), { total: "80", deposit: "30" });
  w.service.proposeMandate(booking.id);
  const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
  w.service.approveMandate(mandate_id, code);
  w.fake.deliver = undefined;
  const b = await w.service.createOrder(booking.id);
  return { w, id: booking.id, orderId: b.order_id! };
}

describe("round 2 #2: merchant ids only", () => {
  it("sandbox mode needs PAYPAL_OPERATOR_MERCHANT_ID; an operator email alone is not enough", () => {
    expect(() => loadConfig({ ...SANDBOX, PAYPAL_GUIDE_PAYEE_MERCHANT_ID: "GUIDEACCOUNT1", PAYPAL_OPERATOR_EMAIL: "owner@business.example.com" })).toThrow(/PAYPAL_OPERATOR_MERCHANT_ID/);
  });

  it("refuses an email guide payee", () => {
    expect(() => loadConfig({ ...SANDBOX, PAYPAL_GUIDE_PAYEE_EMAIL: "guide@business.example.com", PAYPAL_OPERATOR_MERCHANT_ID: "OPERATORACCT1" })).toThrow(/PAYPAL_GUIDE_PAYEE_MERCHANT_ID/);
  });

  it("every seed guide is a merchant id, never an email", () => {
    for (const g of SEED_GUIDES) {
      expect(g.payee.merchant_id).toMatch(/^[A-Z0-9]{13}$/);
      expect(g.payee.email_address).toBeUndefined();
    }
  });

  it("the order is sent with payee.merchant_id only", async () => {
    const { w, orderId } = await ordered();
    expect(w.fake.order(orderId)!.purchase_units![0]!.payee).toEqual({ merchant_id: SEED_GUIDES[0]!.payee.merchant_id });
  });

  it("an order whose payee is only an email (an alias) is not captured", async () => {
    const { w, id, orderId } = await ordered();
    w.fake.mutateOrder(orderId, (o) => {
      o.purchase_units![0]!.payee = { email_address: "LANTERN-RIDGE@business.sandbox.example" };
    });
    w.fake.approve(orderId);
    await expect(w.service.captureIfApproved(id)).rejects.toMatchObject({ code: "order_mismatch" });
    expect(w.fake.calls.filter((c) => c.path.endsWith("/capture"))).toHaveLength(0);
  });
});
