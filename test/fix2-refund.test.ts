// Round 2, #5 (failed refunds release the reservation) and #6 (refund reconciliation fails closed).

import { describe, expect, it } from "vitest";
import { makeWorld, tokenOf } from "./helpers/world.ts";

const CONV = "cv_refund2_0001";

async function paid() {
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
  w.channels.drain(CONV);
  return { w, id: booking.id };
}

describe("round 2 #5: a failed refund releases its reservation", () => {
  it("PAYMENT.REFUND.FAILED refreshes the pending refund and frees the amount", async () => {
    const { w, id } = await paid();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body: { id: "RPEND000000000002", status: "PENDING", amount: { currency_code: "EUR", value: "30.00" } } });
    await w.service.refund(id);
    await expect(w.service.refund(id)).rejects.toMatchObject({ code: "bad_amount" });
    const results: Array<{ status: number }> = [];
    w.fake.deliver = async (raw, headers) => void results.push(await w.service.handleWebhook(raw, headers));
    w.fake.failNext({ method: "GET", path: /^\/v2\/payments\/refunds\//, status: 200, body: { id: "RPEND000000000002", status: "FAILED", amount: { currency_code: "EUR", value: "30.00" } } });
    w.fake.emitWebhook("PAYMENT.REFUND.FAILED", "refund", { id: "RPEND000000000002", status: "FAILED", amount: { currency_code: "EUR", value: "30.00" }, custom_id: id });
    await w.fake.flush();
    expect(results).toEqual([expect.objectContaining({ status: 200 })]);
    expect(w.service.get(id)!.refund_ops[0]!.status).toBe("failed");
    expect((await w.service.refund(id)).status).toBe("refunded");
  });
});

describe("round 2 #6: refund reconciliation fails closed", () => {
  it.each([
    ["a different currency", { id: "RBAD000000000001", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" } }],
    ["a different amount", { id: "RBAD000000000002", status: "COMPLETED", amount: { currency_code: "EUR", value: "9.00" } }],
    ["no amount", { id: "RBAD000000000003", status: "COMPLETED" }],
  ])("%s → needs_review, nothing counted, no success", async (_label, body) => {
    const { w, id } = await paid();
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 201, body });
    const b = await w.service.refund(id, "10.00");
    expect(b.status).toBe("needs_review");
    expect(b.refunded_minor).toBe(0);
    expect(w.channels.drain(CONV).some((e) => e.type === "refunded")).toBe(false);
    expect(w.ledger.list(id).some((e) => e.kind === "refund.reconcile_failed")).toBe(true);
    await expect(w.service.refund(id, "5.00")).rejects.toMatchObject({ code: "refund_under_review" });
  });
});
