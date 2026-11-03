// D2 (DESIGN.md §21): refunds go through the payee's own PayPal app. The booking service still calls one
// PaymentsApi; RoutedPayments sends refundCapture and getRefund to the app of the capture's payee (a map
// keyed by merchant id) and everything else to the operator's app. A payee with no app fails closed before
// any POST: a definitive, never maybe-delivered error, nothing sent.

import { describe, expect, it } from "vitest";
import { isDefinitive } from "../src/booking/service.ts";
import { SEED_GUIDES } from "../src/guides/seed.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { fakeAppFor } from "../src/paypal/fake.ts";
import { RoutedPayments } from "../src/paypal/routed.ts";
import { runTool } from "../src/tools/registry.ts";
import { CONV, type World, deliver, keepWebhooks, paid, refundPosts } from "./helpers/race.ts";
import { makeWorld } from "./helpers/world.ts";

const LANTERN = SEED_GUIDES[0]!.payee.merchant_id;
const OTHER = "OTHERGUIDE001";

/** A PaymentsApi that records each call (method and arguments) under its name and answers `{ id }`. */
function stub(name: string, log: Array<[string, string, unknown[]]>): PaymentsApi {
  return new Proxy({} as PaymentsApi, {
    get: (_t, method: string) => async (...args: unknown[]) => {
      log.push([name, method, args]);
      return { id: `${name}-${method}` };
    },
  });
}

function routed(payees: string[], lookup: { capture?: Record<string, string>; refund?: Record<string, string> } = {}) {
  const log: Array<[string, string, unknown[]]> = [];
  const router = new RoutedPayments({
    operator: stub("operator", log),
    payees: new Map(payees.map((m) => [m, stub(m, log)])),
    lookup: { payeeOfCapture: (c) => lookup.capture?.[c], captureOfRefund: (r) => lookup.refund?.[r] },
  });
  return { router, log, who: () => log.map(([name, method]) => `${name}.${method}`) };
}

async function caught(p: Promise<unknown>): Promise<PayPalError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  if (!(e instanceof PayPalError)) throw new Error(`expected a PayPalError, got ${String(e)}`);
  return e;
}

describe("RoutedPayments: refunds to the payee's own app, the rest to the operator's", () => {
  it("refundCapture and getRefund go to the app of the capture's payee", async () => {
    const r = routed([LANTERN, OTHER], { capture: { CAP1: LANTERN, CAP2: OTHER }, refund: { R1: "CAP1" } });
    await r.router.refundCapture("CAP1", { custom_id: "bk_1" }, "refund-bk_1-1");
    await r.router.refundCapture("CAP2", {}, "refund-bk_2-1");
    await r.router.getRefund("R9", "CAP2");
    // No capture named: the refund operation that recorded the refund id names it.
    await r.router.getRefund("R1");
    expect(r.who()).toEqual([`${LANTERN}.refundCapture`, `${OTHER}.refundCapture`, `${OTHER}.getRefund`, `${LANTERN}.getRefund`]);
    expect(r.log[0]![2]).toEqual(["CAP1", { custom_id: "bk_1" }, "refund-bk_1-1"]);
  });

  it("orders, captures, webhook verification and the owner check go to the operator's app", async () => {
    const r = routed([LANTERN], { capture: { CAP1: LANTERN } });
    await r.router.createOrder({ intent: "CAPTURE", purchase_units: [] }, "nonce");
    await r.router.getOrder("O1");
    await r.router.captureOrder("O1", "capture-O1");
    await r.router.verifyWebhookSignature({ auth_algo: "a", cert_url: "c", transmission_id: "t", transmission_sig: "s", transmission_time: "x" }, { id: "WH-1", event_type: "X", resource: {} });
    await r.router.getAppOwner();
    expect(r.who()).toEqual(["operator.createOrder", "operator.getOrder", "operator.captureOrder", "operator.verifyWebhookSignature", "operator.getAppOwner"]);
  });

  it.each([
    ["a payee with no app", { capture: { CAP1: OTHER } }, (r: RoutedPayments) => r.refundCapture("CAP1", {}, "refund-x-1"), /no PayPal app is configured for payee merchant OTHERGUIDE001/],
    ["a capture no booking has", {}, (r: RoutedPayments) => r.refundCapture("CAPX", {}, "refund-x-1"), /no booking has this capture/],
    ["a refund GET whose capture is unknown", {}, (r: RoutedPayments) => r.getRefund("RX"), /capture is unknown/],
    ["a refund GET for a payee with no app", { capture: { CAP1: OTHER } }, (r: RoutedPayments) => r.getRefund("RX", "CAP1"), /no PayPal app is configured/],
  ])("fails closed, before any call, on %s: definitive, never maybe-delivered", async (_what, lookup, call, message) => {
    const r = routed([LANTERN], lookup);
    const e = await caught(call(r.router));
    expect(e).toMatchObject({ kind: "invalid_request", status: 0, code: "PAYEE_APP_NOT_CONFIGURED", maybeDelivered: false });
    expect(e.message).toMatch(message);
    expect(e.message).toMatch(/nothing was sent/);
    expect(isDefinitive(e)).toBe(true);
    expect(r.log).toEqual([]);
  });

  it("never prints a client", () => {
    expect(JSON.stringify(routed([LANTERN]).router)).toBe(JSON.stringify({ payees: [LANTERN] }));
  });
});

describe("the booking service through the router", () => {
  /** A world whose apps' calls are recorded: "operator", or the payee's merchant id. */
  function recorded(payeeApps?: string[]) {
    const calls: string[] = [];
    const w = makeWorld({
      payeeApps,
      apps: (name, inner) =>
        new Proxy(inner, {
          get: (target, method: string) => {
            const f = (target as unknown as Record<string, unknown>)[method];
            return typeof f === "function" ? (...args: unknown[]) => (calls.push(`${name}.${method}`), (f as (...a: unknown[]) => unknown).apply(target, args)) : f;
          },
        }),
    });
    return { w, calls };
  }

  it("the refund POST and the refund GETs go to the guide's app; orders and captures to the operator's", async () => {
    const { w, calls } = recorded();
    const { id, token } = await paid(w);
    expect(new Set(calls)).toEqual(new Set(["operator.createOrder", "operator.getOrder", "operator.captureOrder"]));
    calls.length = 0;
    await w.service.offerRefund(token);
    w.fake.pendNextRefund();
    expect(await w.service.refund(id, "10.00")).toMatchObject({ refund_ops: [{ status: "pending" }] });
    // get_booking reads the pending refund back (I4): through the guide's app too.
    w.fake.settleRefund(w.fake.refundIds()[0]!, "COMPLETED");
    expect(await w.service.refreshRefunds(id)).toMatchObject({ status: "partially_refunded", refunded_minor: 1000 });
    expect(calls).toEqual([`${LANTERN}.refundCapture`, `${LANTERN}.getRefund`]);
  });

  it("the evidence GET of a refund no operation has (a lost reply) goes to the guide's app, by the booking's capture", async () => {
    const { w, calls } = recorded();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    const got = keepWebhooks(w);
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    w.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, dropResponse: true });
    await expect(w.service.refund(id)).rejects.toMatchObject({ kind: "network" });
    await w.fake.flush();
    calls.length = 0;
    expect(await deliver(w, got[0]!)).toEqual({ status: 200, result: "logged" });
    expect(w.service.get(id)).toMatchObject({ status: "refunded", refund_ops: [{ status: "completed" }] });
    // The refund's event came on the guide app's webhook (D4/D5), so the guide's app verified it too.
    expect(calls).toEqual([`${LANTERN}.verifyWebhookSignature`, `${LANTERN}.getRefund`]);
  });

  it("a guide with no app of its own: the refund fails closed before any POST, and the reservation is released", async () => {
    const { w } = recorded([]);
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    const e = await w.service.refund(id).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(PayPalError);
    expect(e).toMatchObject({ code: "PAYEE_APP_NOT_CONFIGURED", maybeDelivered: false });
    expect(refundPosts(w)).toBe(0);
    expect(w.service.get(id)).toMatchObject({ status: "captured", refunded_minor: 0, refund_ops: [{ n: 1, status: "failed" }] });
    expect(w.service.get(id)!.refund_ops[0]!.maybe_sent).toBeUndefined();
    expect(w.ledger.list(id).map((r) => r.kind).slice(-2)).toEqual(["refund.requested", "refund.failed"]);
    // The agent is told plainly, not "refund_unconfirmed".
    const out = await runTool("refund_payment", { booking_id: id }, { service: w.service, channels: w.channels, conversationId: CONV, sendOperatorLink: () => {} });
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/^PayPal error: .*PAYEE_APP_NOT_CONFIGURED/) });
    expect(refundPosts(w)).toBe(0);
  });

  it("at the fake, the refund POST and GET carry the guide app's token, the order and capture the operator's", async () => {
    const w = makeWorld();
    const { id, token } = await paid(w);
    await w.service.offerRefund(token);
    w.fake.pendNextRefund();
    await w.service.refund(id, "10.00");
    await w.service.refreshRefunds(id);
    const by = (pred: (c: { method: string; path: string }) => boolean) => [...new Set(w.fake.calls.filter(pred).map((c) => c.app))];
    expect(by((c) => /\/refund$/.test(c.path) || c.path.startsWith("/v2/payments/refunds/"))).toEqual([fakeAppFor(LANTERN).clientId]);
    expect(by((c) => c.path.startsWith("/v2/checkout/orders"))).toEqual([w.fake.clientId]);
  });

  it("the service names each capture's payee (from the booking's checked quote) and each recorded refund's capture", async () => {
    const w: World = makeWorld();
    const { id, token } = await paid(w);
    const b = w.service.get(id)!;
    expect(w.service.payeeOfCapture(b.capture_id!)).toBe(LANTERN);
    expect(w.service.payeeOfCapture("CNOSUCHCAPTURE01")).toBeUndefined();
    await w.service.offerRefund(token);
    const done = await w.service.refund(id, "5.00");
    expect(w.service.captureOfRefund(done.refund_ops[0]!.refund_id!)).toBe(b.capture_id);
    expect(w.service.captureOfRefund("RNOSUCHREFUND001")).toBeUndefined();
  });
});
