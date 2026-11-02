// Deterministic races for the booking service: a gate holds one PayPal reply (or one feed lookup) after it
// arrived, while the test changes the booking; then the test releases it. Also the booking fixtures the
// round 6 tests share (a requested, an ordered and a paid booking in one conversation, on 2026-11-05).

import { expect } from "vitest";
import type { PaymentsApi } from "../../src/paypal/api.ts";
import { type makeWorld, tokenOf } from "./world.ts";

export type World = ReturnType<typeof makeWorld>;

export const CONV = "cv_review6_00000001";
export const DATE = "2026-11-05";

/** Holds the next armed call after its real reply arrived, until the test releases it. One use. */
export function gate() {
  let armed = false;
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => (entered = r));
  const releasedP = new Promise<void>((r) => (release = r));
  return {
    arm() {
      armed = true;
    },
    /** Resolves once the armed call has its reply and is waiting. */
    entered: enteredP,
    release: () => release(),
    async pass<T>(call: () => Promise<T>): Promise<T> {
      if (!armed) return call();
      armed = false;
      const value = await call();
      entered();
      await releasedP;
      return value;
    },
  };
}
export type Gate = ReturnType<typeof gate>;

const PAYMENT_METHODS = ["createOrder", "getOrder", "captureOrder", "refundCapture", "getRefund", "verifyWebhookSignature", "getOperatorIdentity"] as const;

/** The REST client, with `method`'s reply held by `g` while armed. */
export function slow(inner: PaymentsApi, method: keyof PaymentsApi, g: Gate): PaymentsApi {
  const out: Record<string, unknown> = {};
  for (const k of PAYMENT_METHODS) {
    out[k] = (...args: unknown[]) => {
      const call = () => (inner[k] as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
      return k === method ? g.pass(call) : call();
    };
  }
  return out as unknown as PaymentsApi;
}

export function requested(w: World) {
  const { booking, operatorUrl } = w.service.requestQuote({ conversation_id: CONV, guide_id: "g_lantern", date: DATE, party_size: 2, activity: "hike" });
  return { id: booking.id, token: tokenOf(operatorUrl) };
}

/** Ordered, with webhooks not delivered (each test drives the service itself). */
export async function ordered(w: World) {
  const r = requested(w);
  w.service.priceQuote(r.token, { total: "80", deposit: "30" });
  w.service.proposeMandate(r.id);
  const { code, mandate_id } = w.channels.inbox(CONV).at(-1)!;
  w.service.approveMandate(mandate_id, code);
  w.fake.deliver = undefined;
  const b = await w.service.createOrder(r.id);
  return { ...r, orderId: b.order_id! };
}

/** Paid (captured): a 30.00 EUR deposit. */
export async function paid(w: World) {
  const r = await ordered(w);
  w.fake.approve(r.orderId);
  expect((await w.service.captureIfApproved(r.id)).captured).toBe(true);
  return r;
}

export const kinds = (w: World, id: string) => w.ledger.list(id).map((e) => e.kind);
/** POSTs to PayPal's refund endpoint (each one is money asked back from the guide). */
export const refundPosts = (w: World) => w.fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/refund")).length;
