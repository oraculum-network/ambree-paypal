// Monday's spike: one real sandbox order whose payee is another sandbox account, end to end.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node scripts/spike.ts --payee-email guide@business.example.com
//
// (a) OAuth token, (b) a CAPTURE order of 10.00 with purchase_units[0].payee, (c) the approve link, then polls
// GET /v2/checkout/orders/{id} until APPROVED, (d) captures, (e) refunds the capture in full, (f) a table of
// HTTP statuses and ids. It never prints a secret or a token, and refuses any base URL but the sandbox.
// It answers DESIGN.md §5 S1-S6 and S9. PAYPAL_WEBHOOK_ID is not needed here.

import { fileURLToPath } from "node:url";
import { PayPalRestClient } from "../src/paypal/client.ts";
import { PayPalError } from "../src/paypal/errors.ts";
import { assertSandboxBase } from "../src/paypal/sandbox.ts";
import type { PaymentsApi } from "../src/paypal/api.ts";
import { type CreateOrderRequest, type CurrencyCode, type Order, type Payee, approveLink, firstCapture } from "../src/paypal/types.ts";

export interface SpikeArgs {
  payee: Payee;
  currency: CurrencyCode;
  value: string;
  timeoutSec: number;
  pollSec: number;
  refund: boolean;
  paymentSource: boolean;
}

export const USAGE =
  "usage: node scripts/spike.ts (--payee-email EMAIL | --payee-merchant-id ID) [--currency EUR|USD] [--amount 10.00] [--timeout 600] [--poll 5] [--no-refund] [--with-payment-source]";

export function parseArgs(argv: string[]): SpikeArgs {
  const out: SpikeArgs = { payee: undefined as unknown as Payee, currency: "EUR", value: "10.00", timeoutSec: 600, pollSec: 5, refund: true, paymentSource: false };
  let email: string | undefined;
  let merchant: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
      return v;
    };
    switch (flag) {
      case "--payee-email":
        email = next();
        break;
      case "--payee-merchant-id":
        merchant = next();
        break;
      case "--currency": {
        const c = next().toUpperCase();
        if (c !== "EUR" && c !== "USD") throw new Error(`--currency must be EUR or USD\n${USAGE}`);
        out.currency = c;
        break;
      }
      case "--amount": {
        const v = next();
        if (!/^\d{1,4}\.\d{2}$/.test(v)) throw new Error(`--amount must look like 10.00\n${USAGE}`);
        out.value = v;
        break;
      }
      case "--timeout":
        out.timeoutSec = positiveInt(flag, next());
        break;
      case "--poll":
        out.pollSec = positiveInt(flag, next());
        break;
      case "--no-refund":
        out.refund = false;
        break;
      case "--with-payment-source":
        out.paymentSource = true;
        break;
      default:
        throw new Error(`unknown argument ${flag.slice(0, 40)}\n${USAGE}`);
    }
  }
  if ((email ? 1 : 0) + (merchant ? 1 : 0) !== 1) throw new Error(`give exactly one of --payee-email or --payee-merchant-id\n${USAGE}`);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--payee-email is not an email address");
  if (merchant && !/^[A-Z0-9]{8,20}$/.test(merchant)) throw new Error("--payee-merchant-id should be the 13-character PayPal merchant id");
  out.payee = email ? { email_address: email } : { merchant_id: merchant! };
  return out;
}

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive whole number of seconds`);
  return n;
}

/** Reads the credentials by name. Errors name the variable only. */
export function readEnv(env: Record<string, string | undefined>): { clientId: string; clientSecret: string; baseUrl: string } {
  const missing = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(" and ")} (sandbox REST app credentials)`);
  return { clientId: env.PAYPAL_CLIENT_ID!, clientSecret: env.PAYPAL_CLIENT_SECRET!, baseUrl: assertSandboxBase(env.PAYPAL_BASE_URL) };
}

export function buildOrder(a: SpikeArgs, runId: string): CreateOrderRequest {
  const body: CreateOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: `spike-${runId}`,
        custom_id: `spike-${runId}`,
        invoice_id: `AMB-SPIKE-${runId}`,
        description: "Ambree spike: guide deposit (sandbox)",
        amount: { currency_code: a.currency, value: a.value },
        payee: a.payee,
      },
    ],
  };
  if (a.paymentSource) {
    body.payment_source = {
      paypal: { experience_context: { return_url: "https://example.com/ambree-spike/return", cancel_url: "https://example.com/ambree-spike/cancel", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", brand_name: "Ambree (sandbox)" } },
    };
  }
  return body;
}

export interface Row {
  step: string;
  call: string;
  status: string;
  id: string;
  note: string;
}

export function formatTable(rows: Row[]): string {
  const head: Row = { step: "step", call: "call", status: "HTTP", id: "id", note: "note" };
  const all = [head, ...rows];
  const keys = Object.keys(head) as Array<keyof Row>;
  const width = Object.fromEntries(keys.map((k) => [k, Math.max(...all.map((r) => r[k].length))])) as Record<keyof Row, number>;
  const line = (r: Row) => keys.map((k) => r[k].padEnd(width[k])).join(" | ").trimEnd();
  return [line(head), keys.map((k) => "-".repeat(width[k])).join("-|-"), ...rows.map(line)].join("\n");
}

/** Drops anything that looks like a token or a Basic/Bearer header from text we print. */
export function scrub(text: string): string {
  return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]").replace(/\bA21AA[A-Za-z0-9._-]+/g, "[token]");
}

export interface SpikeDeps {
  api: PaymentsApi;
  args: SpikeArgs;
  runId: string;
  print: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The HTTP status of the last call (from the client's onCall hook). */
  lastStatus: () => number;
}

function describeError(e: unknown): string {
  return e instanceof PayPalError ? e.summary() : e instanceof Error ? e.message : "unknown error";
}

/** Runs (b)-(e). Returns the rows and whether every step that ran succeeded. */
export async function runSpike(d: SpikeDeps): Promise<{ rows: Row[]; ok: boolean }> {
  const rows: Row[] = [];
  const status = () => String(d.lastStatus() || "-");
  const fail = (step: string, call: string, e: unknown) => {
    rows.push({ step, call, status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(describeError(e)) });
    return { rows, ok: false };
  };

  let order: Order;
  try {
    order = await d.api.createOrder(buildOrder(d.args, d.runId), `spike-create-${d.runId}`);
  } catch (e) {
    return fail("b create", "POST /v2/checkout/orders", e);
  }
  const payee = order.purchase_units?.[0]?.payee;
  rows.push({ step: "b create", call: "POST /v2/checkout/orders", status: status(), id: order.id, note: `status ${order.status}; payee echoed ${JSON.stringify(payee ?? null)}; links ${(order.links ?? []).map((l) => l.rel).join(",")}` });
  const link = approveLink(order);
  if (!link) {
    rows.push({ step: "c approve", call: "-", status: "-", id: order.id, note: "no approve or payer-action link" });
    return { rows, ok: false };
  }
  d.print(`\nApprove the order as the sandbox BUYER (personal account) in a browser:\n  ${link}\nPolling every ${d.args.pollSec}s for up to ${d.args.timeoutSec}s…`);

  const deadline = Date.now() + d.args.timeoutSec * 1000;
  let polls = 0;
  for (;;) {
    try {
      order = await d.api.getOrder(order.id);
      polls++;
    } catch (e) {
      return fail("c poll", "GET /v2/checkout/orders/{id}", e);
    }
    if (order.status === "APPROVED") break;
    if (Date.now() >= deadline) {
      rows.push({ step: "c poll", call: "GET /v2/checkout/orders/{id}", status: status(), id: order.id, note: `timed out at status ${order.status} after ${polls} polls` });
      return { rows, ok: false };
    }
    await d.sleep(d.args.pollSec * 1000);
  }
  rows.push({ step: "c poll", call: "GET /v2/checkout/orders/{id}", status: status(), id: order.id, note: `APPROVED after ${polls} polls; payer ${order.payer?.payer_id ?? "?"}` });

  let capture;
  try {
    const captured = await d.api.captureOrder(order.id, `spike-capture-${d.runId}`);
    capture = firstCapture(captured);
    rows.push({ step: "d capture", call: "POST /v2/checkout/orders/{id}/capture", status: status(), id: capture?.id ?? "(none)", note: `order ${captured.status}; capture ${capture?.status ?? "?"}; custom_id ${capture?.custom_id ?? "(absent)"}` });
  } catch (e) {
    return fail("d capture", "POST /v2/checkout/orders/{id}/capture", e);
  }
  if (!capture) return { rows, ok: false };

  if (!d.args.refund) {
    rows.push({ step: "e refund", call: "-", status: "-", id: "", note: "skipped (--no-refund)" });
    return { rows, ok: true };
  }
  try {
    const refund = await d.api.refundCapture(capture.id, { note_to_payer: "Ambree spike: full refund (sandbox)" }, `spike-refund-${d.runId}`);
    rows.push({ step: "e refund", call: "POST /v2/payments/captures/{id}/refund", status: status(), id: refund.id, note: `refund ${refund.status}; amount ${refund.amount ? `${refund.amount.currency_code} ${refund.amount.value}` : "?"}` });
  } catch (e) {
    return fail("e refund", "POST /v2/payments/captures/{id}/refund", e);
  }
  return { rows, ok: true };
}

async function main(): Promise<number> {
  let args: SpikeArgs;
  let env: ReturnType<typeof readEnv>;
  try {
    args = parseArgs(process.argv.slice(2));
    env = readEnv(process.env);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : "bad arguments"}\n`);
    return 2;
  }
  let last = 0;
  const client = new PayPalRestClient({ ...env, onCall: (c) => (last = c.status) });
  const runId = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  process.stdout.write(`Ambree PayPal spike ${runId} against ${client.baseUrl} (sandbox), payee ${JSON.stringify(args.payee)}, ${args.currency} ${args.value}\n`);

  // (a) the token, on its own so a credential problem is reported as such.
  const rows: Row[] = [];
  try {
    await client.getOrder("SPIKE0TOKEN0CHECK").catch((e: unknown) => {
      if (e instanceof PayPalError && e.status === 404) return; // the token worked; the order doesn't exist
      throw e;
    });
    rows.push({ step: "a token", call: "POST /v1/oauth2/token", status: "200", id: "", note: "token cached (never printed)" });
  } catch (e) {
    rows.push({ step: "a token", call: "POST /v1/oauth2/token", status: e instanceof PayPalError ? String(e.status || e.kind) : "-", id: "", note: scrub(describeError(e)) });
    process.stdout.write(`\n${formatTable(rows)}\n`);
    return 1;
  }

  const result = await runSpike({ api: client, args, runId, print: (l) => process.stdout.write(`${scrub(l)}\n`), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), lastStatus: () => last });
  process.stdout.write(`\n${formatTable([...rows, ...result.rows])}\n\n${result.ok ? "SPIKE OK" : "SPIKE FAILED"}: paste this table into the CTO's notes.\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
