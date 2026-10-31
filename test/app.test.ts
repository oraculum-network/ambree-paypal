import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app.ts";
import { OpenAICompatModel } from "../src/agent/model.ts";
import { ScriptedModel, parseRequest } from "../src/agent/scripted.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { LiveEnvironmentRefused } from "../src/paypal/sandbox.ts";
import { TOOL_NAMES, openAiTools } from "../src/tools/registry.ts";

let app: App;
let base: string;

beforeAll(async () => {
  // Port 0: the OS picks one; PUBLIC_URL is fixed after listen via a second app would be awkward,
  // so pick a port first with a throwaway listen.
  const probe = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }) });
  const port = await probe.listen();
  await probe.close();
  app = createApp({ config: loadConfig({ PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: `http://127.0.0.1:${port}` }), today: () => "2026-11-03" });
  await app.listen();
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await app?.close();
});

const CONV = "cv_apptest0001";
type State = Record<string, any>;

async function post(path: string, body: unknown): Promise<State> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as State;
}
async function state(): Promise<State> {
  return (await (await fetch(`${base}/api/state?conversation_id=${CONV}`)).json()) as State;
}
async function until(pred: (s: State) => boolean, label: string): Promise<State> {
  for (let i = 0; i < 100; i++) {
    const s = await state();
    if (s.pending_events > 0) await post("/api/chat", { conversation_id: CONV });
    else if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function operator(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
}

describe("the whole flow over HTTP (fake PayPal, scripted model)", () => {
  it("request → guide price → mandate → order → checkout → capture → webhooks → cyclone → refund", async () => {
    const first = await post("/api/chat", { conversation_id: CONV, message: "Find me a hiking guide for Le Morne on Thursday and hold the spot" });
    expect(first.replies.at(-1)).toMatch(/Lantern Ridge Walks \(demo\).*2026-11-05/);
    const link = first.guide_phone[0].url as string;
    expect(link).toMatch(/\/o\/[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(first.transcript)).not.toContain(link.split("/o/")[1]);

    const opPage = await fetch(link);
    expect(opPage.status).toBe(200);
    expect(opPage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await opPage.text()).toContain("Your price");
    expect((await operator(link, { action: "price", total: "80", deposit: "30", note: "06:30 car park" })).status).toBe(200);

    let s = await until((x) => x.bookings[0]?.status === "mandate_proposed", "mandate");
    expect(s.transcript.at(-1).text).toMatch(/approve the deposit of EUR 30.00/);
    const code = (s.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
    const mandateId = s.bookings[0].mandate.id as string;
    // The agent never saw the code.
    expect(JSON.stringify(s.transcript)).not.toContain(code);

    const wrong = await post(`/api/mandates/${mandateId}/approve`, { conversation_id: CONV, code: code === "000000" ? "111111" : "000000" });
    expect(wrong.ok).toBe(false);
    const otherConv = await post(`/api/mandates/${mandateId}/approve`, { conversation_id: "cv_someoneelse1", code });
    expect(otherConv.error).toBe("No such mandate.");
    expect((await post(`/api/mandates/${mandateId}/approve`, { conversation_id: CONV, code })).ok).toBe(true);

    s = await until((x) => x.bookings[0]?.status === "order_created", "order");
    const pay = s.bookings[0].order.approve_url as string;
    expect(pay).toContain("/fake-paypal/checkout?token=");
    const checkout = await fetch(pay);
    expect(await checkout.text()).toContain("lantern-ridge@business.sandbox.example");
    const approved = await fetch(pay, { method: "POST", redirect: "manual" });
    expect(approved.status).toBe(303);
    const ret = await fetch(approved.headers.get("location")!, { redirect: "manual" });
    expect(ret.status).toBe(303);
    expect(ret.headers.get("location")).toBe(`/?c=${CONV}`);

    s = await until((x) => x.ledger.some((e: State) => e.kind === "webhook.PAYMENT.CAPTURE.COMPLETED") && x.transcript.at(-1).text.startsWith("Paid"), "capture webhook");
    expect(s.bookings[0]).toMatchObject({ status: "captured", guide_balance: 3000 });
    expect(s.chain.ok).toBe(true);

    expect((await post("/api/demo/cyclone", { conversation_id: CONV })).bookings_warned).toBe(1);
    s = await until((x) => x.bookings[0]?.reschedule?.status === "proposed", "reschedule");
    expect(s.transcript.at(-1).text).toMatch(/move the trip to 2026-11-08/);
    expect(await (await fetch(link)).text()).toContain("Move the trip?");
    await operator(link, { action: "decline_reschedule" });

    s = await until((x) => x.bookings[0]?.status === "refunded" && x.ledger.some((e: State) => e.kind === "webhook.PAYMENT.CAPTURE.REFUNDED"), "refund");
    expect(s.bookings[0].guide_balance).toBe(0);
    expect(s.transcript.map((m: State) => m.text).join("\n")).toMatch(/Done: EUR 30.00 refunded to you/);
    const kinds = s.ledger.map((e: State) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["quote.priced", "mandate.rejected", "mandate.approved", "order.created", "capture.completed", "weather.alert", "reschedule.declined", "refund.completed"]));
    expect(s.chain.ok).toBe(true);
  });

  it("serves health, the page with a CSP, and 404s", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true, paypal: "fake", model: "scripted" });
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("Guide's phone");
    expect((await fetch(`${base}/o/not-a-token`)).status).toBe(404);
    expect((await fetch(`${base}/o/${"A".repeat(43)}`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("refuses bad chat input and unsigned webhooks", async () => {
    expect((await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: "x" }) })).status).toBe(400);
    const wh = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }) });
    expect(wh.status).toBe(400);
  });
});

describe("MCP", () => {
  it("lists the 10 tools (none approves a mandate) and runs search_guides", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.some((t) => /approve_mandate/.test(t.name))).toBe(false);
    expect(tools.find((t) => t.name === "create_order")?.annotations?.destructiveHint).toBe(true);
    const r = await client.callTool({ name: "search_guides", arguments: { area: "Le Morne", activity: "kayak" } });
    expect((r.structuredContent as { count: number }).count).toBe(1);
    const bad = await client.callTool({ name: "create_order", arguments: { booking_id: "bk_000000000000" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe("config", () => {
  it("defaults to the fake and the scripted model", () => {
    const c = loadConfig({});
    expect(c.paypal.mode).toBe("fake");
    expect(c.llm.mode).toBe("scripted");
  });

  it("refuses live PayPal even without credentials", () => {
    expect(() => loadConfig({ PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(LiveEnvironmentRefused);
  });

  it("needs both PayPal credentials and a guide payee for sandbox", () => {
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" })).toThrow(/PAYPAL_GUIDE_PAYEE_EMAIL/);
    const c = loadConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "secret-b", PAYPAL_GUIDE_PAYEE_EMAIL: "g@business.example.com" });
    expect(c.paypal).toMatchObject({ mode: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com" });
    expect(c.guidePayee).toEqual({ email_address: "g@business.example.com" });
  });

  it("errors name variables, never values", () => {
    try {
      loadConfig({ LLM_API_KEY: "sk-very-secret" });
    } catch (e) {
      expect(String(e)).toMatch(/LLM_BASE_URL/);
      expect(String(e)).not.toContain("sk-very-secret");
    }
  });
});

describe("model clients", () => {
  it("the OpenAI-compatible client sends tools and parses tool calls", async () => {
    let sent: any;
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_guides", arguments: '{"area":"Le Morne"}' } }] } }] }));
    }) as unknown as typeof fetch;
    const m = new OpenAICompatModel({ baseUrl: "https://llm.example.com/v1/", apiKey: "k-secret", model: "some-model", fetch: f });
    const r = await m.complete([{ role: "user", content: "hi" }], openAiTools());
    expect(r.tool_calls).toEqual([{ id: "c1", name: "search_guides", arguments: '{"area":"Le Morne"}' }]);
    expect(sent.model).toBe("some-model");
    expect(sent.tools).toHaveLength(10);
    expect(JSON.stringify(m)).not.toContain("k-secret");
    expect(() => new OpenAICompatModel({ baseUrl: "http://llm.example.com", apiKey: "k", model: "m" })).toThrow(/https/);
  });

  it("the scripted model parses requests", async () => {
    expect(parseRequest("Find me a hiking guide for Le Morne on Thursday", "2026-11-03")).toEqual({ area: "Le Morne", activity: "hike", date: "2026-11-05", party_size: 2 });
    expect(parseRequest("kayak in La Gaulette tomorrow, just me", "2026-11-03")).toMatchObject({ area: "La Gaulette", activity: "kayak", date: "2026-11-04", party_size: 1 });
    expect(parseRequest("a guide for four people on 2026-12-01", "2026-11-03")).toMatchObject({ date: "2026-12-01", party_size: 4 });
    const r = await new ScriptedModel(() => "2026-11-03").complete([{ role: "user", content: "hello" }]);
    expect(r.tool_calls).toHaveLength(0);
  });
});
