import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REFUND_CALL, RefundBudget, type RefundCall, RefundGuardRefused, type RefundRun, type Row, buildOrder, formatTable, parseArgs, readEnv, redact, refundOk, refundPremises, refundRows, runSpike, scrub } from "../scripts/spike.ts";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FakePayPal } from "../src/paypal/fake.ts";
import { LiveEnvironmentRefused } from "../src/paypal/sandbox.ts";
import type { Money, Refund } from "../src/paypal/types.ts";

describe("spike arguments", () => {
  it("defaults to EUR 10.00 with the refund sequence", () => {
    const a = parseArgs(["--payee-email", "guide@business.example.com"]);
    expect(a).toMatchObject({ payee: { email_address: "guide@business.example.com" }, currency: "EUR", value: "10.00", refund: true, paymentSource: false });
  });

  it("takes a merchant id, USD and the flags", () => {
    const a = parseArgs(["--payee-merchant-id", "ABCDEFGH12345", "--currency", "usd", "--amount", "12.50", "--timeout", "30", "--poll", "2", "--no-refund", "--with-payment-source"]);
    expect(a).toMatchObject({ payee: { merchant_id: "ABCDEFGH12345" }, currency: "USD", value: "12.50", timeoutSec: 30, pollSec: 2, refund: false, paymentSource: true });
  });

  it.each([
    [[], /exactly one/],
    [["--payee-email", "a@b.co", "--payee-merchant-id", "ABCDEFGH12345"], /exactly one/],
    [["--payee-email"], /needs a value/],
    [["--payee-email", "nope"], /not an email/],
    [["--payee-merchant-id", "x"], /merchant id/],
    [["--payee-email", "a@b.co", "--currency", "MUR"], /EUR or USD/],
    [["--payee-email", "a@b.co", "--amount", "10"], /10\.00/],
    [["--payee-email", "a@b.co", "--timeout", "-1"], /positive/],
    [["--payee-email", "a@b.co", "--live"], /unknown argument/],
  ])("refuses %j", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });
});

describe("spike environment", () => {
  it("names missing variables, never values", () => {
    expect(() => readEnv({ PAYPAL_CLIENT_ID: "x" })).toThrow(/^set PAYPAL_CLIENT_SECRET /);
    expect(() => readEnv({})).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });

  it("refuses a live base URL", () => {
    expect(() => readEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(LiveEnvironmentRefused);
    expect(readEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });
});

describe("spike CLI", () => {
  const run = (env: Record<string, string>, ...argv: string[]) =>
    spawnSync(process.execPath, ["scripts/spike.ts", ...argv], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 10_000 });

  it("exits 2 naming the missing variables, with no network call", () => {
    const r = run({}, "--payee-email", "guide@business.example.com");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
  });

  it("exits 2 on a live base URL without printing the secret", () => {
    const r = run({ PAYPAL_CLIENT_ID: "id-x", PAYPAL_CLIENT_SECRET: "secret-y", PAYPAL_BASE_URL: "https://api-m.paypal.com" }, "--payee-email", "g@business.example.com");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("only https://api-m.sandbox.paypal.com is allowed");
    expect(`${r.stdout}${r.stderr}`).not.toContain("secret-y");
  });
});

describe("spike pure parts", () => {
  it("builds a CAPTURE order with the payee in purchase_units[0]", () => {
    const body = buildOrder(parseArgs(["--payee-email", "g@business.example.com"]), "20261102");
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]).toMatchObject({ amount: { currency_code: "EUR", value: "10.00" }, payee: { email_address: "g@business.example.com" }, custom_id: "spike-20261102" });
    expect(body.payment_source).toBeUndefined();
    expect(buildOrder(parseArgs(["--payee-email", "g@b.co", "--with-payment-source"]), "1").payment_source?.paypal.experience_context?.user_action).toBe("PAY_NOW");
  });

  it("formats an aligned table", () => {
    const t = formatTable([{ step: "b create", call: "POST /v2/checkout/orders", status: "201", id: "ABC", note: "ok" }]);
    const lines = t.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^step\s+\| call\s+\| HTTP \| id\s+\| note$/);
    expect(lines[2]).toContain("POST /v2/checkout/orders | 201  | ABC | ok");
  });

  it("scrubs tokens and auth headers", () => {
    expect(scrub("Authorization: Bearer A21AAabc.def-ghi")).toBe("Authorization: Bearer [redacted]");
    expect(scrub("Basic dXNlcjpwYXNz")).toBe("Basic [redacted]");
    expect(scrub("got A21AAxyz123 back")).toBe("got [token] back");
  });
});

describe("spike run against the fake", () => {
  interface Opts {
    approveAfterPolls?: number;
    dedupe?: boolean;
    customId?: boolean;
    totals?: boolean;
  }
  function harness(argv: string[], opts: Opts = {}) {
    const fake = new FakePayPal();
    if (opts.dedupe !== undefined) fake.dedupe = opts.dedupe;
    if (opts.customId !== undefined) fake.refundCustomId = opts.customId;
    if (opts.totals !== undefined) fake.refundTotals = opts.totals;
    let last = 0;
    let refundPosts = 0;
    const api = new PayPalRestClient({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      fetch: fake.fetch,
      onCall: (c) => {
        last = c.status;
        if (c.call === REFUND_CALL) refundPosts++;
      },
    });
    const printed: string[] = [];
    let sleeps = 0;
    const approveAfterPolls = opts.approveAfterPolls ?? 2;
    return {
      fake,
      printed,
      run: () =>
        runSpike({
          api,
          args: parseArgs(argv),
          runId: "T1",
          print: (l) => printed.push(l),
          lastStatus: () => last,
          refundPosts: () => refundPosts,
          sleep: async () => {
            sleeps++;
            await new Promise((r) => setTimeout(r, 20));
            // The "buyer" approves while the spike polls.
            if (sleeps === approveAfterPolls) {
              const orderId = printed.join("\n").match(/token=([A-Z0-9]+)/)![1]!;
              fake.approve(orderId);
            }
          },
        }),
    };
  }

  const refundPostsIn = (fake: FakePayPal) => fake.calls.filter((c) => c.method === "POST" && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(c.path));
  /** Everything a run would put on the screen: the approve prompt, the table and the premise block. */
  const screen = (printed: string[], rows: Row[], block: string[]) => [...printed, formatTable(rows), ...block].join("\n");
  const NOT_ANSWERED =
    "Not answered by the spike: P3 the resource of PAYMENT.CAPTURE.REFUNDED and of PAYMENT.CAPTURE.REVERSED (a refund, resource_type refund?), P4 the exact refund failure event names (PAYMENT.REFUND.FAILED? PAYMENT.REFUND.CANCELLED?), P6 a refund that is PENDING and then FAILED or CANCELLED. These need the developer dashboard's webhook simulator and the sandbox webhook event log.";

  it("create → approve → capture → the refund premise sequence, with statuses and ids", async () => {
    const h = harness(["--payee-email", "guide@business.example.com", "--poll", "1"]);
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(true);
    expect(rows.map((r) => [r.step, r.status])).toEqual([
      ["b create", "201"],
      ["c poll", "200"],
      ["d capture", "201"],
      ["e1 refund", "201"],
      ["e2 dedupe", "201"],
      ["e3 get", "200"],
      ["e4 rest", "201"],
      ["e5 refusal", "422"],
      ["e6 replay", "201"],
    ]);
    const captureId = rows[2]!.id;
    const [e1, e2, e3, e4, e5, e6] = rows.slice(3);
    expect(rows[0]!.note).toContain('"email_address":"guide@business.example.com"');
    expect(rows[2]!.note).toContain("custom_id spike-T1");
    expect(e1!.note).toBe("COMPLETED; EUR 1.00; custom_id echoed yes; up link names this capture yes; total_refunded_amount EUR 1.00");
    expect(e2!.note).toBe("DEDUPED (same refund id)");
    expect(e2!.id).toBe(e1!.id);
    expect(e3!.note).toBe("COMPLETED; custom_id yes; up link names this capture yes; total_refunded_amount EUR 1.00");
    expect(e3!.id).toBe(e1!.id);
    expect(e4!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 10.00 (= A: yes)");
    expect(e5!.note).toMatch(/^refused as expected: HTTP 422; issues CAPTURE_FULLY_REFUNDED; POST \/v2\/payments\/captures\/\{id\}\/refund · HTTP 422 · CAPTURE_FULLY_REFUNDED · debug_id d[0-9a-f]+$/);
    expect(e6!.note).toBe("DEDUPED (same refund id as e4)");
    expect(e6!.id).toBe(e4!.id);
    // The money: all of A back, never more; e1 and e4 are the only refunds PayPal made.
    expect(h.fake.refundedFrom(captureId)).toBe(1000);
    expect(h.fake.balance({ email_address: "guide@business.example.com" })).toBe(0);
    expect(h.fake.refundIds()).toEqual([e1!.id, e4!.id]);
    // The request ids: e2 repeats e1's, e6 repeats e4's, e5 has its own.
    expect(refundPostsIn(h.fake).map((c) => c.requestId)).toEqual(["spike-refund1-T1", "spike-refund1-T1", "spike-refund2-T1", "spike-refund3-T1", "spike-refund2-T1"]);
    expect(refunds?.customId).toBe("spike-T1");
    expect(screen(h.printed, rows, refundPremises(refunds!))).not.toMatch(/A21AA|Bearer|Basic|fake-client/);
  });

  describe.each([
    { dedupe: true, customId: true, totals: true },
    { dedupe: true, customId: true, totals: false },
    { dedupe: true, customId: false, totals: true },
    { dedupe: true, customId: false, totals: false },
    { dedupe: false, customId: true, totals: true },
    { dedupe: false, customId: true, totals: false },
    { dedupe: false, customId: false, totals: true },
    { dedupe: false, customId: false, totals: false },
  ])("the premise sequence with %j", (s) => {
    it("runs every planned call, refunds exactly A, and reads each premise", async () => {
      const h = harness(["--payee-merchant-id", "GUIDEMERCHANT1", "--poll", "1"], s);
      const { rows, ok, refunds } = await h.run();
      expect(ok).toBe(true);
      const captureId = rows.find((r) => r.step === "d capture")!.id;
      const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
      expect(rows.map((r) => r.status).slice(3)).toEqual(["201", "201", "200", "201", "422", s.dedupe ? "201" : "422"]);

      // Money: never more than A in total, all of A back, 2 or 3 refunds.
      expect(h.fake.refundedFrom(captureId)).toBe(1000);
      expect(h.fake.balance({ merchant_id: "GUIDEMERCHANT1" })).toBe(0);
      expect(h.fake.refundIds()).toHaveLength(s.dedupe ? 2 : 3);
      expect(refundPostsIn(h.fake)).toHaveLength(5);
      expect(byStep["e4 rest"]!.note).toContain(s.dedupe ? "EUR 9.00" : "EUR 8.00");

      const block = refundPremises(refunds!);
      const custom = s.customId ? "yes" : "no (absent)";
      const e2Id = byStep["e2 dedupe"]!.id;
      const getTotal = s.dedupe ? "EUR 1.00" : "EUR 2.00";
      expect(block).toEqual([
        "Refund premises (DESIGN.md §19-§20)",
        s.dedupe
          ? "P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 DEDUPED (same refund id as e4) → yes: a repeated PayPal-Request-Id replays the first reply, also once the capture is fully refunded"
          : `P1 dedupe (e2, e6): e2 NOT DEDUPED (new refund id ${e2Id}); e6 refused (HTTP 422 CAPTURE_FULLY_REFUNDED) → NO: the repeat made a second refund`,
        `P2 custom_id: on the reply ${custom}; on GET ${custom}`,
        "P2b up link to this capture: on the reply yes; on GET yes",
        s.totals
          ? `P5 total_refunded_amount: on the reply EUR 1.00; on GET ${getTotal}; running total yes (e4 shows EUR 10.00, the sum of the refunds so far)`
          : "P5 total_refunded_amount: on the reply absent; on GET absent; running total unknown (absent on e4)",
        `P7 refusal issues: e5 HTTP 422 CAPTURE_FULLY_REFUNDED; e6 ${s.dedupe ? "replayed (same refund id as e4), not refused" : "HTTP 422 CAPTURE_FULLY_REFUNDED"}`,
        NOT_ANSWERED,
      ]);
      expect(s.dedupe ? e2Id === byStep["e1 refund"]!.id : e2Id !== byStep["e1 refund"]!.id).toBe(true);

      const out = screen(h.printed, rows, block);
      expect(out).not.toMatch(/A21AA|Bearer|Basic/);
      expect(out).not.toContain(h.fake.clientId);
      expect(out).not.toContain(h.fake.clientSecret);
    });
  });

  it("refuses the sequence when A is under 2.00, with a row and no refund", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--amount", "1.99", "--poll", "1"]);
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(false);
    expect(rows.at(-1)).toMatchObject({ step: "e refund", call: "-", status: "-" });
    expect(rows.at(-1)!.note).toBe("refused: the capture is EUR 1.99; the premise sequence needs at least 2.00 (e1's 1.00 plus a possible duplicate). Rerun with --amount 2.00 or more");
    expect(refundPostsIn(h.fake)).toHaveLength(0);
    expect(refundPremises(refunds!)).toEqual(["Refund premises (DESIGN.md §19-§20)", "not run: the capture is EUR 1.99; the premise sequence needs at least 2.00 (e1's 1.00 plus a possible duplicate). Rerun with --amount 2.00 or more", NOT_ANSWERED]);
  });

  it("--no-refund skips all of it", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--no-refund", "--poll", "1"]);
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(true);
    expect(rows.map((r) => r.step)).toEqual(["b create", "c poll", "d capture", "e refund"]);
    expect(rows.at(-1)!.note).toBe("skipped (--no-refund)");
    expect(refunds).toBeUndefined();
    expect(refundPostsIn(h.fake)).toHaveLength(0);
    expect(h.fake.calls.some((c) => c.path.startsWith("/v2/payments/refunds/"))).toBe(false);
  });

  it("at exactly 2.00 without dedupe, e1 and e2 refund all of A: e4 and e6 aren't needed, e5 is still refused", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--amount", "2.00", "--poll", "1"], { dedupe: false });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(true);
    const captureId = rows.find((r) => r.step === "d capture")!.id;
    expect(rows.slice(3).map((r) => [r.step, r.status])).toEqual([
      ["e1 refund", "201"],
      ["e2 dedupe", "201"],
      ["e3 get", "200"],
      ["e4 rest", "-"],
      ["e5 refusal", "422"],
      ["e6 replay", "-"],
    ]);
    expect(rows.find((r) => r.step === "e4 rest")!.note).toBe("not needed: e1 and e2 already refunded all of A (EUR 2.00)");
    expect(rows.find((r) => r.step === "e6 replay")!.note).toBe("not needed: e4 wasn't sent");
    expect(h.fake.refundedFrom(captureId)).toBe(200);
    expect(refundPostsIn(h.fake)).toHaveLength(3);
    const block = refundPremises(refunds!);
    expect(block[1]).toMatch(/^P1 dedupe \(e2, e6\): e2 NOT DEDUPED \(new refund id R[0-9A-F]+\); e6 not run \(e4 wasn't sent\) → NO: the repeat made a second refund$/);
    expect(block[4]).toBe("P5 total_refunded_amount: on the reply EUR 1.00; on GET EUR 2.00; running total yes (e2 shows EUR 2.00, the sum of the refunds so far)");
    expect(block[5]).toBe("P7 refusal issues: e5 HTTP 422 CAPTURE_FULLY_REFUNDED; e6 not run (e4 wasn't sent)");
  });

  it("names every issue of the refusal, and says the service reads only the first", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
    // e1, e2 and e4 go through; e5's refusal carries two issues.
    for (let i = 0; i < 3; i++) h.fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true });
    h.fake.failNext({
      method: "POST",
      path: /\/refund$/,
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", debug_id: "d77", details: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "x" }, { issue: "CAPTURE_FULLY_REFUNDED", description: "y" }] },
    });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(true);
    expect(rows.find((r) => r.step === "e5 refusal")!.note).toBe(
      "refused as expected: HTTP 422; issues REFUND_AMOUNT_EXCEEDED, CAPTURE_FULLY_REFUNDED; POST /v2/payments/captures/{id}/refund · HTTP 422 · REFUND_AMOUNT_EXCEEDED · debug_id d77",
    );
    expect(refundPremises(refunds!)[5]).toBe(
      "P7 refusal issues: e5 HTTP 422 REFUND_AMOUNT_EXCEEDED, CAPTURE_FULLY_REFUNDED (the service reads only the first, REFUND_AMOUNT_EXCEEDED); e6 replayed (same refund id as e4), not refused",
    );
  });

  it("money guard: a lost e1 reply that the client retried without dedupe stops the sequence before A is passed", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--amount", "2.00", "--poll", "1"], { dedupe: false });
    // PayPal makes e1's refund, the reply is lost; the client resends the same request id and PayPal makes another.
    h.fake.failNext({ method: "POST", path: /\/refund$/, dropResponse: true, status: 0 });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(false);
    const captureId = rows.find((r) => r.step === "d capture")!.id;
    expect(h.fake.refundIds()).toHaveLength(2);
    expect(h.fake.refundedFrom(captureId)).toBe(200);
    // Only e1's two attempts reached PayPal: the guard refused e2 and e5, and e4 had nothing left.
    expect(refundPostsIn(h.fake)).toHaveLength(2);
    expect(rows.find((r) => r.step === "e2 dedupe")!.note).toBe("not sent: PayPal may already have refunded EUR 2.00 of A (EUR 2.00); another EUR 1.00 could take the capture past A");
    expect(rows.find((r) => r.step === "e5 refusal")!.note).toBe("not sent: PayPal's replies show EUR 1.00 of A (EUR 2.00) refunded, so this probe could still move money");
    expect(refundPremises(refunds!)[1]).toContain("→ unanswered");
  });

  it("times out cleanly if nobody approves", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--timeout", "1", "--poll", "1"], { approveAfterPolls: 10_000 });
    const started = Date.now();
    const { rows, ok } = await h.run();
    expect(ok).toBe(false);
    expect(rows.at(-1)!.note).toMatch(/timed out at status CREATED/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a refused order as a row, not a crash", async () => {
    const h = harness(["--payee-email", "g@business.example.com"]);
    h.fake.failNext({ path: /^\/v2\/checkout\/orders$/, status: 422, body: { name: "UNPROCESSABLE_ENTITY", debug_id: "d9", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED", description: "restricted" }] } });
    const { rows, ok } = await h.run();
    expect(ok).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: "b create", status: "422" });
    expect(rows[0]!.note).toContain("PAYEE_ACCOUNT_RESTRICTED");
  });

  it("stops after e1 when PayPal refuses the first refund (S4), with no further refund POST", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
    h.fake.failNext({ method: "POST", path: /\/refund$/, status: 403, body: { name: "NOT_AUTHORIZED", debug_id: "d5", details: [{ issue: "PERMISSION_DENIED", description: "no" }] } });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(false);
    expect(rows.at(-1)).toMatchObject({ step: "e1 refund", status: "403" });
    expect(rows.at(-1)!.note).toContain("PERMISSION_DENIED");
    expect(refundPostsIn(h.fake)).toHaveLength(1);
    expect(refundPremises(refunds!)[1]).toBe("P1 dedupe (e2, e6): e2 not run; e6 not run → unanswered");
  });
});

describe("refund premises as a pure function of the replies", () => {
  const A: Money = { currency_code: "EUR", value: "10.00" };
  const cap = "CAPTURE0000000001";
  const up = (path: string) => [{ href: `https://api-m.sandbox.paypal.com${path}`, rel: "up", method: "GET" }];
  const refund = (id: string, value: string, extra: Partial<Refund> = {}): Refund => ({ id, status: "COMPLETED", amount: { currency_code: "EUR", value }, custom_id: "spike-X", links: up(`/v2/payments/captures/${cap}`), ...extra });
  const ok = (r: Refund, http = 201): RefundCall => ({ http, refund: r });
  const refused = (http: number, ...issues: string[]): RefundCall => ({ http, error: { kind: "http", issues, summary: `POST /v2/payments/captures/{id}/refund · HTTP ${http}`, maybeDelivered: false } });
  const base = (): RefundRun => ({
    captureId: cap,
    captured: A,
    customId: "spike-X",
    e1: ok(refund("R1", "1.00")),
    e2: ok(refund("R1", "1.00")),
    e3: ok(refund("R1", "1.00"), 200),
    e4: ok(refund("R4", "9.00")),
    e5: refused(422, "CAPTURE_FULLY_REFUNDED"),
    e6: ok(refund("R4", "9.00")),
  });

  it("reads the up link: absent, another capture, an order, not a URL", () => {
    const run = base();
    run.e1 = ok(refund("R1", "1.00", { links: [] }));
    run.e3 = ok(refund("R1", "1.00", { links: up("/v2/payments/captures/OTHERCAPTURE01") }), 200);
    expect(refundPremises(run)[3]).toBe("P2b up link to this capture: on the reply no (absent); on GET other (/v2/payments/captures/OTHERCAPTURE01)");
    run.e1 = ok(refund("R1", "1.00", { links: up("/v2/checkout/orders/ORDER1") }));
    run.e3 = ok(refund("R1", "1.00", { links: [{ href: "::not a url", rel: "up" }] }), 200);
    expect(refundPremises(run)[3]).toBe("P2b up link to this capture: on the reply other (/v2/checkout/orders/ORDER1); on GET other (not a URL)");
    run.e1 = ok(refund("R1", "1.00", { links: [...up("/v2/checkout/orders/ORDER1"), ...up(`/v2/payments/captures/${cap}/`)] }));
    expect(refundPremises(run)[3]).toMatch(/^P2b up link to this capture: on the reply yes;/);
  });

  it("reads custom_id: echoed, absent, another value; unseen when there was no reply", () => {
    const run = base();
    run.e1 = ok(refund("R1", "1.00", { custom_id: "booking-7" }));
    run.e3 = refused(404, "INVALID_RESOURCE_ID");
    expect(refundPremises(run)[2]).toBe("P2 custom_id: on the reply other (booking-7); on GET not seen");
    expect(refundRows(run).find((r) => r.step === "e1 refund")!.note).toContain("custom_id echoed other (booking-7)");
    expect(refundOk(run)).toBe(false);
  });

  it("e2 refused instead of replayed is an answer but not the expected one", () => {
    const run = base();
    run.e2 = refused(422, "DUPLICATE_REQUEST_ID");
    expect(refundPremises(run)[1]).toBe("P1 dedupe (e2, e6): e2 refused (HTTP 422 DUPLICATE_REQUEST_ID); e6 DEDUPED (same refund id as e4) → NO: PayPal refused the repeat rather than replaying it");
    expect(refundRows(run).find((r) => r.step === "e2 dedupe")!.note).toBe("POST /v2/payments/captures/{id}/refund · HTTP 422; issues DUPLICATE_REQUEST_ID");
    expect(refundOk(run)).toBe(false);
  });

  it("e2 deduped and e6 refused: dedupe holds only while the capture has room", () => {
    const run = base();
    run.e6 = refused(422, "CAPTURE_FULLY_REFUNDED");
    expect(refundPremises(run)[1]).toBe(
      "P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 refused (HTTP 422 CAPTURE_FULLY_REFUNDED) → yes while the capture has room; once it is fully refunded the repeat is refused, not replayed",
    );
    expect(refundOk(run)).toBe(true);
  });

  it("a total that is only the refund's own amount is not a running total", () => {
    const run = base();
    const t = (v: string) => ({ seller_payable_breakdown: { total_refunded_amount: { currency_code: "EUR" as const, value: v } } });
    run.e1 = ok(refund("R1", "1.00", t("1.00")));
    run.e3 = ok(refund("R1", "1.00", t("1.00")), 200);
    run.e4 = ok(refund("R4", "9.00", t("9.00")));
    expect(refundPremises(run)[4]).toBe("P5 total_refunded_amount: on the reply EUR 1.00; on GET EUR 1.00; running total no (e4 shows EUR 9.00; the refunds so far sum to EUR 10.00)");
    expect(refundRows(run).find((r) => r.step === "e4 rest")!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 9.00 (= A: no, A is EUR 10.00)");
  });

  it("e5 accepted, or e6 a new refund, is loud and not ok", () => {
    const run = base();
    run.e5 = ok(refund("R5", "1.00"));
    expect(refundRows(run).find((r) => r.step === "e5 refusal")!.note).toBe("UNEXPECTED: PayPal accepted it (refund R5, COMPLETED, EUR 1.00)");
    expect(refundPremises(run)[5]).toBe("P7 refusal issues: e5 ACCEPTED (refund id R5): UNEXPECTED; e6 replayed (same refund id as e4), not refused");
    expect(refundOk(run)).toBe(false);
    const run2 = base();
    run2.e6 = ok(refund("R6", "9.00"));
    expect(refundRows(run2).find((r) => r.step === "e6 replay")!.note).toBe("NOT DEDUPED (new refund id R6, COMPLETED, EUR 9.00): UNEXPECTED on a fully refunded capture");
    expect(refundPremises(run2)[1]).toContain("→ yes for e2, but e6's repeat made a new refund");
    expect(refundOk(run2)).toBe(false);
  });

  it("is ok only when every planned call ran", () => {
    expect(refundOk(base())).toBe(true);
    const missing = base();
    delete missing.e6;
    expect(refundOk(missing)).toBe(false);
    const lost = base();
    lost.e4 = { http: 0, error: { kind: "network", issues: [], summary: "POST /v2/payments/captures/{id}/refund · network", maybeDelivered: true } };
    expect(refundOk(lost)).toBe(false);
    expect(refundOk({ ...base(), refused: "the capture is EUR 1.00" })).toBe(false);
  });
});

describe("the refund money guard", () => {
  const made = (id: string, value: string, status: Refund["status"] = "COMPLETED"): RefundCall => ({ http: 201, refund: { id, status, amount: { currency_code: "EUR", value } } });
  const lost: RefundCall = { http: 0, error: { kind: "network", issues: [], summary: "x", maybeDelivered: true } };
  const refusedAfterLoss: RefundCall = { http: 422, error: { kind: "http", issues: ["X"], summary: "x", maybeDelivered: true } };
  const refused: RefundCall = { http: 422, error: { kind: "http", issues: ["X"], summary: "x", maybeDelivered: false } };

  it("counts a replayed id once, and sends a probe only once PayPal's replies account for all of A", () => {
    const b = new RefundBudget(1000);
    b.assertRoom("e1", 100);
    b.record(100, 1, made("R1", "1.00"));
    expect(() => b.assertFull("e5")).toThrow(RefundGuardRefused);
    b.record(100, 1, made("R1", "1.00"));
    expect([b.worstMinor, b.confirmedMinor]).toEqual([100, 100]);
    b.assertRoom("e4", 900);
    b.record(900, 1, made("R4", "9.00"));
    expect([b.worstMinor, b.confirmedMinor]).toEqual([1000, 1000]);
    expect(() => b.assertRoom("e5", 1)).toThrow(/past A/);
    expect(() => b.assertFull("e5")).not.toThrow();
  });

  it("counts every attempt that may have reached PayPal, and nothing for a definitive refusal", () => {
    const b = new RefundBudget(1000);
    b.record(100, 1, made("R1", "1.00"));
    b.record(100, 2, lost);
    expect([b.worstMinor, b.confirmedMinor]).toEqual([300, 100]);
    expect(() => b.assertRoom("e4", 700)).not.toThrow();
    expect(() => b.assertRoom("e4", 701)).toThrow(RefundGuardRefused);
    b.record(700, 1, refused);
    expect(b.worstMinor).toBe(300);
    b.record(100, 2, refusedAfterLoss);
    expect(b.worstMinor).toBe(400);
    // A client retry that ended in a new refund may have made one more.
    b.record(100, 2, made("R2", "1.00"));
    expect([b.worstMinor, b.confirmedMinor]).toEqual([600, 200]);
    expect(() => b.assertFull("e5")).toThrow(/could still move money/);
  });

  it("doesn't count a FAILED refund as held for the capture", () => {
    const f = new RefundBudget(200);
    f.record(200, 1, made("R9", "2.00", "FAILED"));
    expect(f.confirmedMinor).toBe(0);
    expect(() => f.assertFull("e5")).toThrow(RefundGuardRefused);
  });
});

describe("what the spike prints", () => {
  it("redacts the credentials' literal values as well as token shapes", () => {
    expect(redact("id abcdefgh123 and secret s3cr3t-value; Bearer A21AAxyz", ["abcdefgh123", "s3cr3t-value"])).toBe("id [redacted] and secret [redacted]; Bearer [redacted]");
    // Short values aren't redacted literally (they would garble the text); the CLI never prints them anyway.
    expect(redact("a b c", ["a"])).toBe("a b c");
  });
});
