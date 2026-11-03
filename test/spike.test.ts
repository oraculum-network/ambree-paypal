import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RefundBudget, type RefundCall, RefundGuardRefused, type RefundRun, type Row, buildOrder, formatTable, parseArgs, readEnv, redact, refundOk, refundPremises, refundProblems, refundRows, runSpike, scrub, spikeClient, spikeReport, type SpikeDeps, type SpikeProgress } from "../scripts/spike.ts";
import { FakePayPal, fakeAppFor } from "../src/paypal/fake.ts";
import { toMinor } from "../src/paypal/money.ts";
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
    /** Runs just before the n-th refund POST exchange (1-based, a 401 included) reaches the fake. */
    beforeRefundPost?: (n: number, fake: FakePayPal) => void;
    /** The fake handles the n-th refund POST exchange (or refund GET) as usual, but its reply arrives with this body. */
    replyBody?: { post?: number; get?: number; body: string };
    /** Changes the deps the run gets (e.g. a counter that throws). */
    wrapDeps?: (d: SpikeDeps) => SpikeDeps;
  }
  /** One refund POST exchange as the spike sent it: its request id, the amount asked, and what was left of A on the capture then. */
  interface Ask {
    requestId: string;
    minor: number;
    room: number;
  }
  function harness(argv: string[], opts: Opts = {}) {
    // The payee's own app (PAYPAL_REFUND_CLIENT_*): PayPal refuses the operator's app a refund of another
    // account's capture (DESIGN.md §21), so every refund call of the run goes through this one.
    const refundApp = { ...fakeAppFor("GUIDEMERCHANT1"), ownerEmails: ["guide@business.example.com", "g@business.example.com"] };
    const fake = new FakePayPal({ apps: [refundApp] });
    if (opts.dedupe !== undefined) fake.dedupe = opts.dedupe;
    if (opts.customId !== undefined) fake.refundCustomId = opts.customId;
    if (opts.totals !== undefined) fake.refundTotals = opts.totals;
    const capturedMinor = toMinor(parseArgs(argv).value);
    const asks: Ask[] = [];
    let posts = 0;
    let gets = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const captureId = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)?.[1];
      let replace = false;
      if (method === "POST" && captureId) {
        posts++;
        opts.beforeRefundPost?.(posts, fake);
        const body = JSON.parse(String(init?.body)) as { amount: Money };
        asks.push({ requestId: new Headers(init?.headers).get("PayPal-Request-Id") ?? "", minor: toMinor(body.amount.value), room: capturedMinor - fake.refundedFrom(decodeURIComponent(captureId)) });
        replace = opts.replyBody?.post === posts;
      } else if (method === "GET" && path.startsWith("/v2/payments/refunds/")) {
        gets++;
        replace = opts.replyBody?.get === gets;
      }
      const res = await fake.fetch(input, init);
      return replace && res.ok ? new Response(opts.replyBody!.body || null, { status: res.status, headers: { "Content-Type": "application/json" } }) : res;
    }) as typeof globalThis.fetch;
    // The clients and their counters as main builds them: writes sent once, a 401 not counted as a refund exchange.
    const { client: api, refunder, lastStatus, refundPosts } = spikeClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch }, { clientId: refundApp.clientId, clientSecret: refundApp.clientSecret });
    const printed: string[] = [];
    let sleeps = 0;
    const approveAfterPolls = opts.approveAfterPolls ?? 2;
    return {
      fake,
      printed,
      asks,
      run: (progress?: SpikeProgress) => {
        const deps: SpikeDeps = {
          api,
          refundApi: refunder,
          args: parseArgs(argv),
          runId: "T1",
          print: (l) => printed.push(l),
          lastStatus,
          refundPosts,
          sleep: async () => {
            sleeps++;
            await new Promise((r) => setTimeout(r, 20));
            // The "buyer" approves while the spike polls.
            if (sleeps === approveAfterPolls) {
              const orderId = printed.join("\n").match(/token=([A-Z0-9]+)/)![1]!;
              fake.approve(orderId);
            }
          },
        };
        return runSpike(opts.wrapDeps ? opts.wrapDeps(deps) : deps, progress);
      },
    };
  }

  type Failure = Omit<Parameters<FakePayPal["failNext"]>[0], "method" | "path">;
  /** The n-th refund POST exchange (1-based) and the ones right after it fail as `fs` say; the ones before go through. */
  const onRefundPost = (fake: FakePayPal, n: number, ...fs: Failure[]) => {
    for (let i = 1; i < n; i++) fake.failNext({ method: "POST", path: /\/refund$/, status: 0, pass: true });
    for (const f of fs) fake.failNext({ method: "POST", path: /\/refund$/, ...f });
  };
  /**
   * The money, from the fake's side: every refund POST that PayPal could take as a new refund fits in what was
   * left of A when it was sent, and a probe (e5, then e6) goes out only once all of A is refunded. PayPal's own
   * cap is then never what keeps the money at A. (A literal sum of the asks can't be the test: with dedupe, e1,
   * e2 and e4 ask 11.00 of 10.00, and e5 and e6 ask beyond A on purpose.)
   */
  const expectAsksFit = (asks: Ask[]) => {
    const probe = asks.findIndex((a) => a.requestId.startsWith("spike-refund3-"));
    asks.forEach((a, i) => {
      if (probe >= 0 && i >= probe) expect(a.room, `probe ${i + 1} (${a.requestId}) sent before all of A was refunded`).toBe(0);
      else expect(a.minor, `refund POST ${i + 1} (${a.requestId}) asks more than is left of A`).toBeLessThanOrEqual(a.room);
    });
  };
  const LABEL = { e1: "e1 refund", e2: "e2 dedupe", e3: "e3 get", e4: "e4 rest", e4b: "e4b get", e5: "e5 refusal", e6: "e6 replay" } as const;
  const refundPostsIn = (fake: FakePayPal) => fake.calls.filter((c) => c.method === "POST" && /^\/v2\/payments\/captures\/[^/]+\/refund$/.test(c.path));
  /** Everything a run would put on the screen: the approve prompt, the table and the premise block. */
  const screen = (printed: string[], rows: Row[], block: string[]) => [...printed, formatTable(rows), ...block].join("\n");
  const NOT_ANSWERED =
    "Not answered by the spike: P3 the resource of PAYMENT.CAPTURE.REFUNDED and of PAYMENT.CAPTURE.REVERSED (a refund, resource_type refund?), P4 the exact refund failure event names (PAYMENT.REFUND.FAILED? PAYMENT.REFUND.CANCELLED?), P6 a refund that is PENDING and then FAILED or CANCELLED. These need the developer dashboard's webhook simulator and the sandbox webhook event log.";
  const LOST_NOTE = /^no answer \(the reply may have been lost; PayPal may have refunded\): POST \/v2\/payments\/captures\/\{id\}\/refund · (network|HTTP 503)/;

  it("create → approve → capture → the refund premise sequence, with statuses and ids", async () => {
    const h = harness(["--payee-email", "guide@business.example.com", "--poll", "1"]);
    const { rows, ok, refunds, problem } = await h.run();
    expect([ok, problem]).toEqual([true, undefined]);
    expect(rows.map((r) => [r.step, r.status])).toEqual([
      ["b create", "201"],
      ["c poll", "200"],
      ["d capture", "201"],
      ["e1 refund", "201"],
      ["e2 dedupe", "201"],
      ["e3 get", "200"],
      ["e4 rest", "201"],
      ["e4b get", "200"],
      ["e5 refusal", "422"],
      ["e6 replay", "201"],
    ]);
    const captureId = rows[2]!.id;
    const [e1, e2, e3, e4, e4b, e5, e6] = rows.slice(3);
    expect(rows[0]!.note).toContain('"email_address":"guide@business.example.com"');
    expect(rows[2]!.note).toContain("custom_id spike-T1");
    expect(e1!.note).toBe("COMPLETED; EUR 1.00; custom_id echoed yes; up link names this capture yes; total_refunded_amount EUR 1.00");
    expect(e2!.note).toBe("DEDUPED (same refund id)");
    expect(e2!.id).toBe(e1!.id);
    expect(e3!.note).toBe("COMPLETED; custom_id yes; up link names this capture yes; total_refunded_amount EUR 1.00");
    expect(e3!.id).toBe(e1!.id);
    expect(e4!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 10.00 (= A: yes)");
    // e4b reads e1 again, after e4: the GET now shows the capture's running total.
    expect(e4b!.note).toBe("COMPLETED; total_refunded_amount EUR 10.00");
    expect(e4b!.id).toBe(e1!.id);
    expect(e5!.note).toMatch(/^refused as expected: HTTP 422; issues CAPTURE_FULLY_REFUNDED; POST \/v2\/payments\/captures\/\{id\}\/refund · HTTP 422 · CAPTURE_FULLY_REFUNDED · debug_id d[0-9a-f]+$/);
    expect(e6!.note).toBe("DEDUPED (same refund id as e4)");
    expect(e6!.id).toBe(e4!.id);
    // The money: all of A back, never more; e1 and e4 are the only refunds PayPal made.
    expect(h.fake.refundedFrom(captureId)).toBe(1000);
    expect(h.fake.balance({ email_address: "guide@business.example.com" })).toBe(0);
    expect(h.fake.refundIds()).toEqual([e1!.id, e4!.id]);
    expectAsksFit(h.asks);
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
      expect(rows.map((r) => r.status).slice(3)).toEqual(["201", "201", "200", "201", "200", "422", s.dedupe ? "201" : "422"]);

      // Money: never more than A in total, all of A back, 2 or 3 refunds.
      expect(h.fake.refundedFrom(captureId)).toBe(1000);
      expect(h.fake.balance({ merchant_id: "GUIDEMERCHANT1" })).toBe(0);
      expect(h.fake.refundIds()).toHaveLength(s.dedupe ? 2 : 3);
      expect(refundPostsIn(h.fake)).toHaveLength(5);
      expect(byStep["e4 rest"]!.note).toContain(s.dedupe ? "EUR 9.00" : "EUR 8.00");
      expectAsksFit(h.asks);

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
          ? `P5 total_refunded_amount: on the reply EUR 1.00; on GET ${getTotal}; running total yes (e4 shows EUR 10.00, the sum of the refunds so far); GET after e4 running total yes (EUR 10.00)`
          : "P5 total_refunded_amount: on the reply absent; on GET absent; running total unknown (absent on e4); GET after e4 absent",
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

  it("at exactly 2.00 without dedupe, e1 and e2 refund all of A: e4, e4b and e6 aren't needed, e5 is still refused", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--amount", "2.00", "--poll", "1"], { dedupe: false });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(true);
    const captureId = rows.find((r) => r.step === "d capture")!.id;
    expect(rows.slice(3).map((r) => [r.step, r.status])).toEqual([
      ["e1 refund", "201"],
      ["e2 dedupe", "201"],
      ["e3 get", "200"],
      ["e4 rest", "-"],
      ["e4b get", "-"],
      ["e5 refusal", "422"],
      ["e6 replay", "-"],
    ]);
    expect(rows.find((r) => r.step === "e4 rest")!.note).toBe("not needed: e1 and e2 already refunded all of A (EUR 2.00)");
    expect(rows.find((r) => r.step === "e4b get")!.note).toBe("not needed: e4 wasn't sent");
    expect(rows.find((r) => r.step === "e6 replay")!.note).toBe("not needed: e4 wasn't sent");
    expect(h.fake.refundedFrom(captureId)).toBe(200);
    expect(refundPostsIn(h.fake)).toHaveLength(3);
    expectAsksFit(h.asks);
    const block = refundPremises(refunds!);
    expect(block[1]).toMatch(/^P1 dedupe \(e2, e6\): e2 NOT DEDUPED \(new refund id R[0-9A-F]+\); e6 not run \(e4 wasn't sent\) → NO: the repeat made a second refund$/);
    expect(block[4]).toBe("P5 total_refunded_amount: on the reply EUR 1.00; on GET EUR 2.00; running total yes (e2 shows EUR 2.00, the sum of the refunds so far); GET after e4 not run (e4 wasn't sent)");
    expect(block[5]).toBe("P7 refusal issues: e5 HTTP 422 CAPTURE_FULLY_REFUNDED; e6 not run (e4 wasn't sent)");
  });

  it("names every issue of the refusal, and says the service reads only the first", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
    // e1, e2 and e4 go through; e5's refusal carries two issues.
    onRefundPost(h.fake, 4, {
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

  // Each refund POST is one exchange: the client doesn't resend it, so its own retry never mixes into the
  // dedupe experiment (P1) or makes a refund the spike can't see (P5).
  describe.each([
    { lost: "e1", n: 1, amount: "10.00", dedupe: true, posts: 1, refunded: 100 },
    { lost: "e1", n: 1, amount: "10.00", dedupe: false, posts: 1, refunded: 100 },
    { lost: "e1", n: 1, amount: "2.00", dedupe: true, posts: 1, refunded: 100 },
    { lost: "e1", n: 1, amount: "2.00", dedupe: false, posts: 1, refunded: 100 },
    { lost: "e2", n: 2, amount: "10.00", dedupe: true, posts: 3, refunded: 900 },
    { lost: "e2", n: 2, amount: "10.00", dedupe: false, posts: 3, refunded: 1000 },
    { lost: "e2", n: 2, amount: "10.00", dedupe: false, posts: 3, refunded: 1000, status: 503 },
    { lost: "e2", n: 2, amount: "2.00", dedupe: true, posts: 2, refunded: 100 },
    { lost: "e2", n: 2, amount: "2.00", dedupe: false, posts: 2, refunded: 200 },
    { lost: "e4", n: 3, amount: "10.00", dedupe: true, posts: 3, refunded: 1000 },
    { lost: "e4", n: 3, amount: "10.00", dedupe: false, posts: 3, refunded: 1000 },
    { lost: "e4", n: 3, amount: "2.00", dedupe: true, posts: 3, refunded: 200 },
    { lost: "e5", n: 4, amount: "10.00", dedupe: true, posts: 5, refunded: 1000 },
    { lost: "e6", n: 5, amount: "10.00", dedupe: true, posts: 5, refunded: 1000 },
  ] as Array<{ lost: "e1" | "e2" | "e4" | "e5" | "e6"; n: number; amount: string; dedupe: boolean; posts: number; refunded: number; status?: number }>)(
    "a lost $lost reply (HTTP $status) at A = $amount, dedupe $dedupe",
    (c) => {
      it("is one exchange and no answer; the guard counts it; every premise that needs it reads unanswered", async () => {
        const h = harness(["--payee-email", "g@business.example.com", "--amount", c.amount, "--poll", "1"], { dedupe: c.dedupe });
        // PayPal acts on the request, then its reply is lost.
        onRefundPost(h.fake, c.n, { dropResponse: true, status: c.status ?? 0 });
        const { rows, ok, refunds, problem } = await h.run();
        expectAsksFit(h.asks);
        expect(ok).toBe(false);
        // SPIKE FAILED names the call.
        expect(problem).toMatch(new RegExp(`(^|; )${c.lost}: no answer \\(the reply may have been lost; PayPal may have refunded\\)`));
        const captureId = rows.find((r) => r.step === "d capture")!.id;
        const row = rows.find((r) => r.step === LABEL[c.lost])!;
        expect(row.status).toBe(c.status ? String(c.status) : "network");
        expect(row.note).toMatch(LOST_NOTE);
        expect(refundPostsIn(h.fake)).toHaveLength(c.posts);
        expect(h.asks).toHaveLength(c.posts);
        expect(h.fake.refundedFrom(captureId)).toBe(c.refunded);

        const block = refundPremises(refunds!);
        const noAnswer = "no answer (the reply may have been lost; PayPal may have refunded)";
        switch (c.lost) {
          case "e1":
            expect(rows.at(-1)!.step).toBe("e1 refund");
            expect(block[1]).toBe("P1 dedupe (e2, e6): e2 not run; e6 not run → unanswered");
            expect(block[5]).toBe("P7 refusal issues: e5 not run; e6 not run");
            break;
          case "e2":
          case "e4":
            if (c.lost === "e2") expect(block[1]).toMatch(/^P1 dedupe \(e2, e6\): e2 no answer \(the reply may have been lost; PayPal may have refunded\); .* → unanswered$/);
            expect(block[4]).toContain(`running total unanswered (${c.lost} may have made a refund the spike never saw)`);
            // PayPal's replies don't show all of A refunded, so neither probe is sent.
            expect(rows.find((r) => r.step === "e5 refusal")!.note).toMatch(/^not sent: /);
            expect(block[5]).toMatch(/^P7 refusal issues: e5 not sent \(/);
            break;
          case "e5":
            expect(block[5]).toBe(`P7 refusal issues: e5 ${noAnswer}; e6 replayed (same refund id as e4), not refused`);
            break;
          case "e6":
            expect(block[1]).toBe(`P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 ${noAnswer} → yes for e2; e6 unanswered`);
            break;
        }
      });
    },
  );

  // A refusal is a 422, or another 4xx that names an issue and isn't 401, 403 or 429. Any other 4xx says
  // nothing about the refund: no answer, and the run is not OK.
  const RATE = { name: "RATE_LIMIT_REACHED", message: "Too many requests.", debug_id: "d429" };
  const BAD_TOKEN = { error: "invalid_token", error_description: "Token signature verification failed" };
  const DENIED = { name: "NOT_AUTHORIZED", debug_id: "d403", details: [{ issue: "PERMISSION_DENIED", description: "no" }] };
  const NOT_FOUND = { name: "RESOURCE_NOT_FOUND", debug_id: "d404" };
  describe.each([
    { step: "e2", n: 2, status: 429, body: RATE },
    { step: "e2", n: 2, status: 403, body: DENIED },
    { step: "e5", n: 4, status: 429, body: RATE },
    // A 401 that survives the client's one token refresh.
    { step: "e5", n: 4, status: 401, body: BAD_TOKEN, times: 2 },
    { step: "e6", n: 5, status: 429, body: RATE },
    { step: "e6", n: 5, status: 404, body: NOT_FOUND },
  ] as Array<{ step: "e2" | "e5" | "e6"; n: number; status: number; body: unknown; times?: number }>)("an HTTP $status on $step", (c) => {
    it("is no answer, not a refusal: its premise reads unanswered and the run is not OK", async () => {
      const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
      onRefundPost(h.fake, c.n, ...Array.from({ length: c.times ?? 1 }, () => ({ status: c.status, body: c.body })));
      const { rows, ok, refunds, problem } = await h.run();
      expect(ok).toBe(false);
      expect(problem).toBe(`${c.step}: no answer (HTTP ${c.status} is not a refusal)`);
      const row = rows.find((r) => r.step === LABEL[c.step])!;
      expect(row.status).toBe(String(c.status));
      expect(row.note).toMatch(new RegExp(`^no answer \\(HTTP ${c.status} is not a refusal\\): POST /v2/payments/captures/\\{id\\}/refund · HTTP ${c.status}`));
      const captureId = rows.find((r) => r.step === "d capture")!.id;
      expect(h.fake.refundedFrom(captureId)).toBe(1000);
      expectAsksFit(h.asks);
      const block = refundPremises(refunds!);
      const no = `no answer (HTTP ${c.status} is not a refusal)`;
      if (c.step === "e2") expect(block[1]).toBe(`P1 dedupe (e2, e6): e2 ${no}; e6 DEDUPED (same refund id as e4) → unanswered`);
      if (c.step === "e5") expect(block[5]).toBe(`P7 refusal issues: e5 ${no}; e6 replayed (same refund id as e4), not refused`);
      if (c.step === "e6") {
        expect(block[1]).toBe(`P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 ${no} → yes for e2; e6 unanswered`);
        expect(block[5]).toBe(`P7 refusal issues: e5 HTTP 422 CAPTURE_FULLY_REFUNDED; e6 ${no}`);
      }
    });
  });

  it("a 400 that names an issue is a refusal: e5 is answered and the run is OK", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
    onRefundPost(h.fake, 4, { status: 400, body: { name: "INVALID_REQUEST", debug_id: "d400", details: [{ issue: "INVALID_PARAMETER_VALUE", description: "x" }] } });
    const { ok, refunds } = await h.run();
    expect(ok).toBe(true);
    expect(refundPremises(refunds!)[5]).toBe("P7 refusal issues: e5 HTTP 400 INVALID_PARAMETER_VALUE; e6 replayed (same refund id as e4), not refused");
  });

  // PayPal answered 2xx, so it acted on the POST; a reply with no readable refund in it is an invalid reply
  // that may have refunded: the guard counts it, and it is never DEDUPED.
  describe.each([
    { what: "an empty 201", dedupe: false, body: "", refunded: 1000 },
    { what: "an empty 201", dedupe: true, body: "", refunded: 900 },
    { what: "a 201 with no refund id", dedupe: true, body: '{"status":"COMPLETED"}', refunded: 900 },
  ])("$what on e2 (dedupe $dedupe)", (c) => {
    it("may have refunded: e4 refunds only what is surely left, no probe is sent, P1 is unanswered", async () => {
      const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"], { dedupe: c.dedupe, replyBody: { post: 2, body: c.body } });
      const { rows, ok, refunds } = await h.run();
      expectAsksFit(h.asks);
      expect(ok).toBe(false);
      const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
      expect(byStep["e2 dedupe"]).toMatchObject({ status: "201", id: "" });
      expect(byStep["e2 dedupe"]!.note).toMatch(/^no answer \(HTTP 201 with no refund in the reply; PayPal may have refunded\)/);
      expect(byStep["e4 rest"]!.note).toContain("EUR 8.00");
      expect(byStep["e5 refusal"]!.note).toMatch(/^not sent: /);
      expect(byStep["e6 replay"]!.note).toMatch(/^not sent: /);
      expect(h.fake.refundedFrom(byStep["d capture"]!.id)).toBe(c.refunded);
      const block = refundPremises(refunds!);
      expect(block[1]).toMatch(/^P1 dedupe \(e2, e6\): e2 no answer \(HTTP 201 with no refund in the reply; PayPal may have refunded\); .* → unanswered$/);
      expect(block[4]).toContain("running total unanswered (e2 may have made a refund the spike never saw)");
    });
  });

  it("an empty 200 on e3 is no answer for the GET; the sequence goes on and the run is not OK", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"], { replyBody: { get: 1, body: "" } });
    const { rows, ok, refunds } = await h.run();
    expect(ok).toBe(false);
    const byStep = Object.fromEntries(rows.map((r) => [r.step, r]));
    expect(byStep["e3 get"]).toMatchObject({ status: "200", id: "" });
    expect(byStep["e3 get"]!.note).toMatch(/^no answer \(HTTP 200 with no refund in the reply\)/);
    expect(byStep["e4 rest"]!.note).toContain("EUR 9.00");
    expect(byStep["e5 refusal"]!.status).toBe("422");
    expect(byStep["e6 replay"]!.note).toBe("DEDUPED (same refund id as e4)");
    expect(h.fake.refundedFrom(byStep["d capture"]!.id)).toBe(1000);
    expectAsksFit(h.asks);
    expect(refundPremises(refunds!)[2]).toBe("P2 custom_id: on the reply yes; on GET not seen");
  });

  it("a token refresh on e2 isn't a refund exchange: e4 still refunds the rest and the run is OK", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"], { beforeRefundPost: (n, fake) => n === 2 && fake.expireTokens() });
    const { rows, ok } = await h.run();
    expect(refundPostsIn(h.fake).map((c) => c.status)).toEqual([201, 401, 201, 201, 422, 201]);
    expect(ok).toBe(true);
    expect(rows.find((r) => r.step === "e4 rest")!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 10.00 (= A: yes)");
    expect(h.fake.refundedFrom(rows.find((r) => r.step === "d capture")!.id)).toBe(1000);
    expectAsksFit(h.asks);
  });

  describe("what main prints after the run (spikeReport)", () => {
    const HEAD: Row[] = [{ step: "a token", call: "POST /v1/oauth2/token", status: "200", id: "", note: "token cached (never printed)" }];

    it("OK: the table, the premise block and SPIKE OK", async () => {
      const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
      const progress: SpikeProgress = { rows: [] };
      const result = await h.run(progress);
      const { ok, text } = spikeReport(HEAD, progress, { result });
      expect(ok).toBe(true);
      expect(text).toMatch(/\ne4b get +\| GET \/v2\/payments\/refunds\/\{id\} +\| 200 /);
      expect(text).toContain("\n\nRefund premises (DESIGN.md §19-§20)\nP1 dedupe (e2, e6): e2 DEDUPED");
      expect(text.endsWith("\n\nSPIKE OK: paste this table and the premise block into the CTO's notes.")).toBe(true);
    });

    it("not OK: SPIKE FAILED names the reason", async () => {
      const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"]);
      onRefundPost(h.fake, 4, { status: 429, body: RATE });
      const progress: SpikeProgress = { rows: [] };
      const { ok, text } = spikeReport(HEAD, progress, { result: await h.run(progress) });
      expect(ok).toBe(false);
      expect(text.endsWith("\n\nSPIKE FAILED (e5: no answer (HTTP 429 is not a refusal)): paste this table and the premise block into the CTO's notes.")).toBe(true);
    });

    it("a run that throws: the rows so far, where it stopped, the premise block, then SPIKE FAILED", async () => {
      let n = 0;
      // The 5th read of the refund counter is e4's, before it is sent.
      const h = harness(["--payee-email", "g@business.example.com", "--poll", "1"], {
        wrapDeps: (d) => ({ ...d, refundPosts: () => (++n === 5 ? (() => { throw new Error("counter broke"); })() : d.refundPosts()) }),
      });
      const progress: SpikeProgress = { rows: [] };
      const crash = await h.run(progress).then(() => undefined, (e: unknown) => e);
      expect(crash).toBeInstanceOf(Error);
      expect(refundPostsIn(h.fake)).toHaveLength(2);
      const { ok, text } = spikeReport(HEAD, progress, { crash });
      expect(ok).toBe(false);
      const steps = text.split("\n").map((l) => l.split(" | ")[0]!.trim());
      expect(steps.slice(3, 10)).toEqual(["a token", "b create", "c poll", "d capture", "e1 refund", "e2 dedupe", "e3 get"]);
      expect(text).toMatch(/\nstopped +\| - +\| - +\| +\| the run stopped: counter broke\n/);
      expect(text).toContain("P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 not run → yes for e2; e6 unanswered");
      expect(text.endsWith("\n\nSPIKE FAILED (the run stopped: counter broke): paste this table and the premise block into the CTO's notes.")).toBe(true);
    });

    it("never throws itself: a row or a block that can't be rendered is replaced", () => {
      const trap = { id: "R1", get status(): never { throw new Error("bad status") } } as unknown as Refund;
      const progress: SpikeProgress = { rows: [], refunds: { captureId: "C1", captured: { currency_code: "EUR", value: "10.00" }, customId: "spike-X", e1: { http: 201, refund: trap } } };
      const { ok, text } = spikeReport(HEAD, progress, { crash: new Error("bad status") });
      expect(ok).toBe(false);
      expect(text).toContain("| R1 | (this row couldn't be shown)");
      expect(text).toContain("Refund premises (DESIGN.md §19-§20)\n(the premises couldn't be read from what the run saw)");
    });
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
    const { rows, ok, refunds, problem } = await h.run();
    expect([ok, problem]).toEqual([false, "e1: HTTP 403 PERMISSION_DENIED"]);
    expect(rows.at(-1)).toMatchObject({ step: "e1 refund", status: "403" });
    expect(rows.at(-1)!.note).toBe("POST /v2/payments/captures/{id}/refund · HTTP 403 · PERMISSION_DENIED · debug_id d5; issues PERMISSION_DENIED");
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
    expect(refundProblems(run)).toEqual(["e2: refused (HTTP 422 DUPLICATE_REQUEST_ID), not the expected answer"]);
  });

  it("names every call that didn't answer as its step can", () => {
    expect(refundProblems(base())).toEqual([]);
    const run = base();
    run.e3 = refused(404, "INVALID_RESOURCE_ID");
    run.e5 = refused(429, "RATE_LIMIT_REACHED");
    run.e6 = { http: 0, guard: "x" };
    expect(refundProblems(run)).toEqual(["e3: HTTP 404 INVALID_RESOURCE_ID", "e5: no answer (HTTP 429 is not a refusal)", "e6: not sent (the money guard)"]);
    const odd = base();
    odd.e5 = ok(refund("R5", "1.00"));
    odd.e6 = ok(refund("R6", "9.00"));
    expect(refundProblems(odd)).toEqual(["e5: PayPal accepted it (refund R5): UNEXPECTED", "e6: a new refund R6: UNEXPECTED"]);
    expect(refundProblems({ ...base(), refused: "the capture is EUR 1.00" })).toEqual(["the refund sequence didn't run (see its row)"]);
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
    expect(refundPremises(run)[4]).toBe("P5 total_refunded_amount: on the reply EUR 1.00; on GET EUR 1.00; running total no (e4 shows EUR 9.00; the refunds so far sum to EUR 10.00); GET after e4 not run");
    expect(refundRows(run).find((r) => r.step === "e4 rest")!.note).toBe("COMPLETED; EUR 9.00; total_refunded_amount EUR 9.00 (= A: no, A is EUR 10.00)");
  });

  it("e4b, e1 read again after e4: GET shows the running total, the total when e1 was made, or another", () => {
    const run = base();
    const t = (v: string) => ({ seller_payable_breakdown: { total_refunded_amount: { currency_code: "EUR" as const, value: v } } });
    run.e1 = ok(refund("R1", "1.00", t("1.00")));
    const again = (v?: string) => {
      run.e4b = ok(refund("R1", "1.00", v ? t(v) : {}), 200);
      return refundPremises(run)[4]!.replace(/^.*; GET after e4 /, "");
    };
    expect(again("10.00")).toBe("running total yes (EUR 10.00)");
    expect(again("1.00")).toBe("running total no (EUR 1.00, as on e1's reply; the refunds so far sum to EUR 10.00)");
    expect(again("7.00")).toBe("running total no (EUR 7.00; the refunds so far sum to EUR 10.00)");
    expect(again()).toBe("absent");
    run.e4b = { http: 404, error: { kind: "http", issues: ["INVALID_RESOURCE_ID"], summary: "GET /v2/payments/refunds/{id} · HTTP 404", maybeDelivered: false } };
    expect(refundPremises(run)[4]).toMatch(/; GET after e4 not seen$/);
    // Informational: a failed e4b doesn't fail the run.
    expect(refundOk(run)).toBe(true);
    expect(refundRows(run).find((r) => r.step === "e4b get")).toMatchObject({ call: "GET /v2/payments/refunds/{id}", status: "404" });
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

  it("a 4xx answers P1 or P7 only as a refusal: a 422, or another 4xx that names an issue and isn't 401, 403 or 429", () => {
    const cases: Array<[RefundCall, boolean, string]> = [
      [refused(422), true, "HTTP 422 with no issue names"],
      [refused(400, "INVALID_PARAMETER_VALUE"), true, "HTTP 400 INVALID_PARAMETER_VALUE"],
      [refused(429), false, "no answer (HTTP 429 is not a refusal)"],
      [refused(429, "RATE_LIMIT_REACHED"), false, "no answer (HTTP 429 is not a refusal)"],
      [refused(401), false, "no answer (HTTP 401 is not a refusal)"],
      [refused(403, "PERMISSION_DENIED"), false, "no answer (HTTP 403 is not a refusal)"],
      [refused(404), false, "no answer (HTTP 404 is not a refusal)"],
    ];
    for (const [c, refusal, text] of cases) {
      const on5 = base();
      on5.e5 = c;
      expect(refundOk(on5), `e5 ${c.http}`).toBe(refusal);
      expect(refundPremises(on5)[5]).toBe(`P7 refusal issues: e5 ${text}; e6 replayed (same refund id as e4), not refused`);
      const on6 = base();
      on6.e6 = c;
      expect(refundOk(on6), `e6 ${c.http}`).toBe(refusal);
      expect(refundPremises(on6)[1]).toBe(
        `P1 dedupe (e2, e6): e2 DEDUPED (same refund id); e6 ${refusal ? `refused (${text})` : text} → ${refusal ? "yes while the capture has room; once it is fully refunded the repeat is refused, not replayed" : "yes for e2; e6 unanswered"}`,
      );
      const on2 = base();
      on2.e2 = c;
      expect(refundPremises(on2)[1]).toMatch(refusal ? / → NO: PayPal refused the repeat rather than replaying it$/ : / → unanswered$/);
    }
  });

  it("a refusal after a lost attempt is no answer: that attempt may have made the refund", () => {
    const run = base();
    run.e2 = { http: 422, error: { kind: "http", issues: ["CAPTURE_FULLY_REFUNDED"], summary: "POST /v2/payments/captures/{id}/refund · HTTP 422 · CAPTURE_FULLY_REFUNDED", maybeDelivered: true } };
    expect(refundPremises(run)[1]).toBe("P1 dedupe (e2, e6): e2 no answer (an earlier attempt's reply may have been lost; PayPal may have refunded); e6 DEDUPED (same refund id as e4) → unanswered");
    expect(refundRows(run).find((r) => r.step === "e2 dedupe")!.note).toBe(
      "no answer (an earlier attempt's reply may have been lost; PayPal may have refunded): POST /v2/payments/captures/{id}/refund · HTTP 422 · CAPTURE_FULLY_REFUNDED; issues CAPTURE_FULLY_REFUNDED",
    );
    expect(refundOk(run)).toBe(false);
  });

  it("a refund reply that may have been lost leaves P5's running total unanswered, not no", () => {
    const run = base();
    const t = (v: string) => ({ seller_payable_breakdown: { total_refunded_amount: { currency_code: "EUR" as const, value: v } } });
    // e2's reply was lost after PayPal made a second 1.00; e4's total counts it, the refunds seen don't.
    run.e1 = ok(refund("R1", "1.00", t("1.00")));
    run.e2 = { http: 0, error: { kind: "network", issues: [], summary: "POST /v2/payments/captures/{id}/refund · network", maybeDelivered: true } };
    run.e4 = ok(refund("R4", "8.00", t("10.00")));
    expect(refundPremises(run)[4]).toBe("P5 total_refunded_amount: on the reply EUR 1.00; on GET absent; running total unanswered (e2 may have made a refund the spike never saw); GET after e4 not run");
  });

  it("a call with neither a refund nor an error is no answer, renders, and isn't ok", () => {
    const run = base();
    run.e2 = { http: 201 };
    run.e5 = { http: 0 };
    expect(refundRows(run).find((r) => r.step === "e2 dedupe")!.note).toBe("no answer (nothing came back)");
    const block = refundPremises(run);
    expect(block[1]).toBe("P1 dedupe (e2, e6): e2 no answer (nothing came back); e6 DEDUPED (same refund id as e4) → unanswered");
    expect(block[5]).toBe("P7 refusal issues: e5 no answer (nothing came back); e6 replayed (same refund id as e4), not refused");
    expect(refundOk(run)).toBe(false);
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

  it("counts a POST that came back with neither a refund nor an error as one that may have refunded", () => {
    const b = new RefundBudget(1000);
    b.record(100, 1, { http: 201 });
    expect([b.worstMinor, b.confirmedMinor]).toEqual([100, 0]);
  });

  it("reserves the amount once for every exchange a POST may take", () => {
    const b = new RefundBudget(1000, "EUR", 2);
    b.record(100, 1, made("R1", "1.00"));
    expect(() => b.assertRoom("e4", 450)).not.toThrow();
    expect(() => b.assertRoom("e4", 451)).toThrow("another EUR 4.51 on each of 2 exchanges could take the capture past A");
    expect(() => new RefundBudget(1000, "EUR", 0)).toThrow(RangeError);
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
