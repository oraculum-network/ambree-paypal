// D6 (DESIGN.md §21): the spike after 3 Nov. Its refund calls go through PAYPAL_REFUND_CLIENT_ID/_SECRET
// (the payee's own app) when set; the a2 row reads the payee echo for the operator's app and that app; and
// `--capture <id> --remaining <amount>` reruns e1-e6 on an existing capture, with A = --remaining. The money
// guard then never lets PayPal refund more than A, and e1's total_refunded_amount must equal what the capture
// had refunded before (its amount less --remaining) plus e1's 1.00, or the run stops before e2.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { type SpikeDeps, identityRows, parseArgs, readEnv, refundPremises, runSpike, spikeClient } from "../scripts/spike.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { firstCapture } from "../src/paypal/types.ts";

const PAYEE = { merchant_id: "GUIDEMERCHANT1" };
const eur = (value: string) => ({ currency_code: "EUR" as const, value });
/** The payee's own app (PAYPAL_REFUND_CLIENT_*); the fake, like PayPal, refuses the operator's app its refunds. */
const REFUND_APP = fakeAppFor(PAYEE.merchant_id);
const refundCreds = { clientId: REFUND_APP.clientId, clientSecret: REFUND_APP.clientSecret };

describe("spike arguments: --capture and --remaining", () => {
  it("takes an existing capture and what is left on it", () => {
    const a = parseArgs(["--capture", "2GG279541U471931P", "--remaining", "9.00"]);
    expect(a).toMatchObject({ capture: { id: "2GG279541U471931P", remaining: "9.00" } });
    expect(a.payee).toBeUndefined();
  });

  it.each([
    [["--capture", "2GG279541U471931P"], /--capture and --remaining go together/],
    [["--remaining", "9.00"], /--capture and --remaining go together/],
    [["--capture", "2GG279541U471931P", "--remaining", "9"], /--remaining must look like 9\.00/],
    [["--capture", "not-a-capture", "--remaining", "9.00"], /--capture should be a PayPal capture id/],
    [["--capture", "2GG279541U471931P", "--remaining", "9.00", "--payee-merchant-id", "ABCDEFGH12345"], /--capture takes only --remaining/],
    [["--capture", "2GG279541U471931P", "--remaining", "9.00", "--amount", "10.00"], /--capture takes only --remaining/],
    [["--capture", "2GG279541U471931P", "--remaining", "9.00", "--no-refund"], /--capture takes only --remaining/],
  ])("refuses %j", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });

  it("the CLI exits 2 on a lone --capture, before any network call", () => {
    const r = spawnSync(process.execPath, ["scripts/spike.ts", "--capture", "2GG279541U471931P"], { env: { PATH: process.env.PATH ?? "", PAYPAL_CLIENT_ID: "id-x", PAYPAL_CLIENT_SECRET: "secret-y" }, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--capture and --remaining go together");
    expect(`${r.stdout}${r.stderr}`).not.toContain("secret-y");
  });
});

describe("spike environment: the refund app", () => {
  it("reads PAYPAL_REFUND_CLIENT_ID and _SECRET together, or neither", () => {
    const base = { PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" };
    expect(readEnv(base).refund).toBeUndefined();
    expect(readEnv({ ...base, PAYPAL_REFUND_CLIENT_ID: "c", PAYPAL_REFUND_CLIENT_SECRET: "d" }).refund).toEqual({ clientId: "c", clientSecret: "d" });
    expect(() => readEnv({ ...base, PAYPAL_REFUND_CLIENT_ID: "c" })).toThrow(/^set both PAYPAL_REFUND_CLIENT_ID and PAYPAL_REFUND_CLIENT_SECRET, or neither/);
    expect(() => readEnv({ ...base, PAYPAL_REFUND_CLIENT_SECRET: "d" })).toThrow(/PAYPAL_REFUND_CLIENT_ID/);
  });
});

/** Records which app made each call: `name.method`. */
function recorded<T extends object>(name: string, inner: T, log: string[]): T {
  return new Proxy(inner, {
    get: (target, method: string) => {
      const f = (target as Record<string, unknown>)[method];
      return typeof f === "function" ? (...args: unknown[]) => (log.push(`${name}.${method}`), (f as (...a: unknown[]) => unknown).apply(target, args)) : f;
    },
  });
}

/**
 * A capture of `captured` to PAYEE, made by the operator's app, with `before` refunded already by the refund
 * app; then the spike as main runs it, with the operator's client and the refund app's sharing the counters.
 */
async function onCapture(o: { captured?: string; before?: string; argvRemaining?: string; totals?: boolean; captureId?: string } = {}) {
  const fake = new FakePayPal({ apps: [REFUND_APP] });
  const shared = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch }, refundCreds);
  const order = await shared.client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur(o.captured ?? "10.00"), payee: PAYEE, custom_id: "spike-old" }] }, "old-order");
  fake.approve(order.id);
  const captureId = firstCapture(await shared.client.captureOrder(order.id, "old-capture"))!.id;
  if (o.before) await shared.refunder.refundCapture(captureId, { amount: eur(o.before) }, "old-refund");
  if (o.totals === false) fake.refundTotals = false;
  const log: string[] = [];
  const postsBefore = shared.refundPosts();
  const deps: SpikeDeps = {
    api: recorded("operator", shared.client as PaymentsApi, log),
    refundApi: recorded("refunder", shared.refunder as PaymentsApi, log),
    args: parseArgs(["--capture", o.captureId ?? captureId, "--remaining", o.argvRemaining ?? "7.00"]),
    runId: "T2",
    print: () => {},
    sleep: async () => {},
    lastStatus: shared.lastStatus,
    refundPosts: shared.refundPosts,
  };
  const result = await runSpike(deps);
  return { fake, captureId, result, log, posts: () => shared.refundPosts() - postsBefore, byStep: Object.fromEntries(result.rows.map((r) => [r.step, r])) };
}

describe("spike --capture: e1-e6 on an existing capture, A = --remaining", () => {
  it("skips a-d, reads the capture (e0), refunds exactly what remains through the refund app, and reads the premises", async () => {
    const r = await onCapture({ before: "3.00", argvRemaining: "7.00" });
    expect([r.result.ok, r.result.problem]).toEqual([true, undefined]);
    expect(r.result.rows.map((x) => [x.step, x.status])).toEqual([
      ["e0 capture", "200"],
      ["e1 refund", "201"],
      ["e1 check", "-"],
      ["e2 dedupe", "201"],
      ["e3 get", "200"],
      ["e4 rest", "201"],
      ["e4b get", "200"],
      ["e5 refusal", "422"],
      ["e6 replay", "201"],
    ]);
    expect(r.byStep["e0 capture"]!.note).toBe("PARTIALLY_REFUNDED; EUR 10.00; --remaining EUR 7.00, so EUR 3.00 was refunded before this run");
    expect(r.byStep["e1 check"]!.note).toBe("consistent with --remaining: total_refunded_amount EUR 4.00 = EUR 3.00 before this run + e1's EUR 1.00");
    expect(r.byStep["e4 rest"]!.note).toBe("COMPLETED; EUR 6.00; total_refunded_amount EUR 10.00 (= C, the capture's amount: yes)");
    // Never more than A: 3.00 before, 7.00 now, all of the capture back.
    expect(r.fake.refundedFrom(r.captureId)).toBe(1000);
    expect(r.posts()).toBe(5);
    // The operator's app reads the capture; every refund call goes through the refund app.
    expect(r.log).toEqual(["operator.getCapture", "refunder.refundCapture", "refunder.refundCapture", "refunder.getRefund", "refunder.refundCapture", "refunder.getRefund", "refunder.refundCapture", "refunder.refundCapture"]);
    const block = refundPremises(r.result.refunds!);
    expect(block[4]).toBe(
      "P5 total_refunded_amount: on the reply EUR 4.00; on GET EUR 4.00; running total yes (e4 shows EUR 10.00, the sum of the refunds so far and EUR 3.00 before this run); GET after e4 running total yes (EUR 10.00)",
    );
    expect(block[1]).toMatch(/→ yes: a repeated PayPal-Request-Id replays the first reply/);
  });

  it("a capture with nothing refunded yet: --remaining is all of it", async () => {
    const r = await onCapture({ argvRemaining: "10.00" });
    expect(r.result.ok).toBe(true);
    expect(r.byStep["e0 capture"]!.note).toBe("COMPLETED; EUR 10.00; --remaining EUR 10.00, so EUR 0.00 was refunded before this run");
    expect(r.byStep["e4 rest"]!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 10.00 (= A: yes)");
    expect(r.fake.refundedFrom(r.captureId)).toBe(1000);
  });

  it.each([
    ["overstated (9.00 said, 7.00 left)", "9.00", "EUR 2.00"],
    ["understated (5.00 said, 7.00 left)", "5.00", "EUR 6.00"],
  ])("--remaining %s: e1's total doesn't match, so the run stops before e2 and refunds nothing more", async (_what, said, expected) => {
    const r = await onCapture({ before: "3.00", argvRemaining: said });
    expect(r.result.ok).toBe(false);
    expect(r.result.rows.map((x) => x.step)).toEqual(["e0 capture", "e1 refund", "e1 check"]);
    expect(r.byStep["e1 check"]!.note).toBe(`stopped: e1's total_refunded_amount is EUR 4.00, but --remaining EUR ${said} on a capture of EUR 10.00 means PayPal should show ${expected}; nothing more was sent (rerun with the right --remaining)`);
    expect(r.result.problem).toMatch(/^e1 check: e1's total_refunded_amount is EUR 4\.00, but --remaining/);
    expect(r.posts()).toBe(1);
    expect(r.fake.refundedFrom(r.captureId)).toBe(400);
  });

  it("no total_refunded_amount on e1's reply: --remaining can't be checked, so the run stops before e2", async () => {
    const r = await onCapture({ before: "3.00", totals: false });
    expect(r.result.ok).toBe(false);
    expect(r.byStep["e1 check"]!.note).toBe("stopped: e1's reply has no total_refunded_amount, so --remaining EUR 7.00 can't be checked; nothing more was sent");
    expect(r.posts()).toBe(1);
  });

  it.each([
    ["more than the capture", { argvRemaining: "12.00" }, "--remaining EUR 12.00 is more than the capture's amount (EUR 10.00)"],
    ["all of it when part was refunded", { before: "3.00", argvRemaining: "10.00" }, "the capture is PARTIALLY_REFUNDED, so less than all of it (EUR 10.00) remains, not --remaining EUR 10.00"],
    ["less than all when nothing was refunded", { argvRemaining: "7.00" }, "the capture is COMPLETED (nothing refunded yet), so all of it (EUR 10.00) remains, not --remaining EUR 7.00"],
    ["anything once it is fully refunded", { before: "10.00", argvRemaining: "2.00" }, "the capture is REFUNDED; there is nothing left to refund"],
    ["under the sequence's minimum", { before: "8.50", argvRemaining: "1.50" }, "--remaining EUR 1.50; the premise sequence needs at least 2.00 left on the capture (e1's 1.00 plus a possible duplicate)"],
  ])("refuses before any refund POST: --remaining %s", async (_what, o, why) => {
    const r = await onCapture(o);
    expect(r.result.ok).toBe(false);
    expect(r.result.rows.at(-1)).toMatchObject({ step: "e refund", note: `refused: ${why}` });
    expect(r.posts()).toBe(0);
  });

  it("an unknown capture: e0's error row, and no refund POST", async () => {
    const r = await onCapture({ captureId: "C0000000000000000" });
    expect(r.result).toMatchObject({ ok: false, problem: "stopped at e0 capture (see its row)" });
    expect(r.byStep["e0 capture"]).toMatchObject({ status: "404" });
    expect(r.posts()).toBe(0);
  });
});

describe("spike: the refund app", () => {
  it("one counter for both clients: refund POSTs through the refund app count, and the last status is either's", async () => {
    const fake = new FakePayPal({ apps: [REFUND_APP] });
    const s = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch }, refundCreds);
    expect(s.refunder).not.toBe(s.client);
    const o = await s.client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("5.00"), payee: PAYEE }] }, "o1");
    expect(s.lastStatus()).toBe(201);
    fake.approve(o.id);
    const cap = firstCapture(await s.client.captureOrder(o.id, "c1"))!;
    await s.refunder.refundCapture(cap.id, { amount: eur("1.00") }, "r1");
    expect(s.refundPosts()).toBe(1);
    await s.refunder.getRefund("RNOSUCHREFUND0001").catch(() => undefined);
    expect(s.lastStatus()).toBe(404);
    // Without a refund app, the operator's client is the refunder too.
    const alone = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
    expect(alone.refunder).toBe(alone.client);
  });

  it("the a2 rows: the operator's app, and the refund app when it is set, each with its own owner", async () => {
    const fake = new FakePayPal({ ownerMerchantId: "OWNERACCOUNT1", apps: [REFUND_APP] });
    const s = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch }, refundCreds);
    const both = await identityRows(s.client, s.refunder);
    expect(both.map((r) => [r.step, r.call, r.id])).toEqual([
      ["a2 identity", "POST /v2/checkout/orders", "OWNERACCOUNT1"],
      ["a2 identity (refund app)", "POST /v2/checkout/orders", PAYEE.merchant_id],
    ]);
    expect((await identityRows(s.client)).map((r) => r.step)).toEqual(["a2 identity"]);
  });

  it("without a refund app the operator's app refunds, and PayPal (the fake) refuses e1 with 403 PERMISSION_DENIED, as on 3 Nov", async () => {
    const fake = new FakePayPal({ apps: [REFUND_APP] });
    const s = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch });
    const order = await s.client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: eur("10.00"), payee: PAYEE }] }, "o-s4");
    fake.approve(order.id);
    const captureId = firstCapture(await s.client.captureOrder(order.id, "c-s4"))!.id;
    const result = await runSpike({ api: s.client, args: parseArgs(["--capture", captureId, "--remaining", "10.00"]), runId: "T4", print: () => {}, sleep: async () => {}, lastStatus: s.lastStatus, refundPosts: s.refundPosts });
    expect([result.ok, result.problem]).toEqual([false, "e1: HTTP 403 PERMISSION_DENIED"]);
    expect(fake.refundedFrom(captureId)).toBe(0);
  });

  it("a normal run sends every refund call through the refund app, and the rest through the operator's", async () => {
    const fake = new FakePayPal({ apps: [REFUND_APP] });
    const s = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch }, refundCreds);
    const log: string[] = [];
    let printed = "";
    const result = await runSpike({
      api: recorded("operator", s.client as PaymentsApi, log),
      refundApi: recorded("refunder", s.refunder as PaymentsApi, log),
      args: parseArgs(["--payee-merchant-id", "GUIDEMERCHANT1", "--poll", "1"]),
      runId: "T3",
      print: (l) => void (printed += l),
      sleep: async () => {
        fake.approve(printed.match(/token=([A-Z0-9]+)/)![1]!);
      },
      lastStatus: s.lastStatus,
      refundPosts: s.refundPosts,
    });
    expect(result.ok).toBe(true);
    expect(new Set(log.filter((l) => l.startsWith("operator.")))).toEqual(new Set(["operator.createOrder", "operator.getOrder", "operator.captureOrder"]));
    expect(new Set(log.filter((l) => l.startsWith("refunder.")))).toEqual(new Set(["refunder.refundCapture", "refunder.getRefund"]));
  });
});
