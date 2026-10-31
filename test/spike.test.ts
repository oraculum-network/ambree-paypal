import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildOrder, formatTable, parseArgs, readEnv, runSpike, scrub } from "../scripts/spike.ts";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { FakePayPal } from "../src/paypal/fake.ts";
import { LiveEnvironmentRefused } from "../src/paypal/sandbox.ts";

describe("spike arguments", () => {
  it("defaults to EUR 10.00 with a full refund", () => {
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
  function harness(argv: string[], approveAfterPolls = 2) {
    const fake = new FakePayPal();
    let last = 0;
    const api = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, fetch: fake.fetch, onCall: (c) => (last = c.status) });
    const printed: string[] = [];
    let sleeps = 0;
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

  it("create → approve → capture → full refund, with statuses and ids", async () => {
    const h = harness(["--payee-email", "guide@business.example.com", "--poll", "1"]);
    const { rows, ok } = await h.run();
    expect(ok).toBe(true);
    expect(rows.map((r) => [r.step, r.status])).toEqual([
      ["b create", "201"],
      ["c poll", "200"],
      ["d capture", "201"],
      ["e refund", "201"],
    ]);
    expect(rows[0]!.note).toContain('"email_address":"guide@business.example.com"');
    expect(rows[2]!.note).toContain("custom_id spike-T1");
    expect(rows[3]!.note).toContain("EUR 10.00");
    expect(h.fake.balance({ email_address: "guide@business.example.com" })).toBe(0);
    expect(h.printed.join("\n")).not.toMatch(/A21AA|Bearer/);
  });

  it("times out cleanly if nobody approves", async () => {
    const h = harness(["--payee-email", "g@business.example.com", "--timeout", "1", "--poll", "1"], 10_000);
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
});
