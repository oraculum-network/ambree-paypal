// The HTTP app: chat page and API, the guide's operator page, PayPal's return URL and webhook, MCP, the
// demo cyclone control (fake and sandbox mode; live PayPal is refused at startup) and, in fake mode only, a
// stand-in PayPal checkout page. No framework.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Agent } from "./agent/loop.ts";
import { type ChatModel, OpenAICompatModel } from "./agent/model.ts";
import { ScriptedModel } from "./agent/scripted.ts";
import { Channels } from "./booking/channels.ts";
import { BookingService, ServiceError } from "./booking/service.ts";
import type { Config } from "./config.ts";
import { guidesWithPayee } from "./guides/seed.ts";
import { Ledger } from "./ledger/ledger.ts";
import { Mandates } from "./mandate/mandate.ts";
import { handleMcp } from "./mcp/server.ts";
import { applyOperatorAction, esc, renderInvalidLink, renderOperatorPage } from "./operator/page.ts";
import type { PaymentsApi } from "./paypal/api.ts";
import { PayPalRestClient } from "./paypal/client.ts";
import { PayPalError } from "./paypal/errors.ts";
import { FakePayPal } from "./paypal/fake.ts";
import { formatMoney } from "./paypal/money.ts";
import { redactPath } from "./http/redact.ts";
import { isOperator } from "./mandate/mandate.ts";
import { Records, openDb } from "./store/db.ts";
import { addDays } from "./agent/scripted.ts";
import { DemoCycloneFeed } from "./weather/cyclones.ts";

export const VERSION = "0.1.0";
export const SESSION_COOKIE = "amb_sid";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const JSON_LIMIT = 16 * 1024;
const WEBHOOK_LIMIT = 256 * 1024;
const MCP_LIMIT = 64 * 1024;

export type Logger = (fields: Record<string, unknown>) => void;

export interface AppOptions {
  config: Config;
  logger?: Logger;
  /** Tests inject a model; otherwise it follows config.llm. */
  model?: ChatModel;
  today?: () => string;
  /** Fake mode only: the merchant id the fake PayPal reports as the REST app's owner (tests). */
  fakeOwnerMerchantId?: string;
  /**
   * Tests only, sandbox mode only: the fetch the PayPal REST client uses (a stub, or FakePayPal.fetch), so
   * sandbox-mode routes run with no network. The client still refuses any base URL but the sandbox's.
   */
  paypalFetch?: typeof fetch;
}

export interface App {
  server: Server;
  service: BookingService;
  fake?: FakePayPal;
  listen(): Promise<number>;
  close(): Promise<void>;
}

const PUBLIC_DIR = join(import.meta.dirname, "..", "public");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/labels.js": { file: "labels.js", type: "text/javascript; charset=utf-8" },
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self' https://www.sandbox.paypal.com; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // same-origin, not no-referrer: an operator URL (a capability) still never leaves our origin, and
  // browsers keep sending a real Origin on form POSTs (no-referrer makes it "null", which the Origin check refuses).
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
}

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8", extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(body);
}
const sendJson = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value));
const redirect = (res: ServerResponse, to: string) => send(res, 303, "", "text/plain", { Location: to });

async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Whether the request says its body is JSON. Media types are case-insensitive (RFC 9110 §8.3.1), so
 * "Application/JSON; charset=UTF-8" counts. The mutation check and the body reader both use this one test,
 * so a body that passes the 415 check is never then dropped.
 */
export function isJsonRequest(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
}

async function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown> | undefined> {
  if (!isJsonRequest(req)) return undefined;
  const raw = await readBody(req, limit);
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(opts: AppOptions): App {
  const { config } = opts;
  const log: Logger = opts.logger ?? (() => {});
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  const db = openDb(config.dbPath);
  const ledger = new Ledger(db);
  // The ledger head kept outside the database: logged on every append and served at /api/ledger/head,
  // so a deleted tail or a rolled-back file is caught by verify(checkpoint).
  let checkpoint = ledger.head();
  ledger.onAppend = (c) => {
    checkpoint = c;
    log({ event: "ledger_head", count: c.count, head: c.head });
  };
  const mandates = new Mandates(db);
  const channels = new Channels();
  const weather = new DemoCycloneFeed();
  let port = config.port;

  let fake: FakePayPal | undefined;
  let payments: PaymentsApi;
  if (config.paypal.mode === "fake") {
    fake = new FakePayPal({ checkoutUrl: `${config.publicUrl}/fake-paypal/checkout`, ownerMerchantId: opts.fakeOwnerMerchantId });
    // Deliver the fake's webhooks over real HTTP to our own endpoint, as PayPal would.
    fake.deliver = async (raw, headers) => {
      await fetch(`http://127.0.0.1:${port}/webhooks/paypal`, { method: "POST", headers, body: raw, signal: AbortSignal.timeout(10_000) });
    };
    payments = new PayPalRestClient({ clientId: fake.clientId, clientSecret: fake.clientSecret, webhookId: fake.webhookId, fetch: fake.fetch });
  } else {
    payments = new PayPalRestClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, webhookId: config.paypal.webhookId, baseUrl: config.paypal.baseUrl, fetch: opts.paypalFetch, onCall: (c) => log({ event: "paypal", ...c }) });
  }

  const guides = guidesWithPayee(config.guidePayee);
  for (const g of guides) {
    if (isOperator(g.payee, config.operatorPayees)) throw new Error(`Guide ${g.id}'s payee is the operator's own account; Ambree must never be the payee`);
  }
  const service = new BookingService({ db, ledger, mandates, payments, guides, weather, channels, publicUrl: config.publicUrl, operatorPayees: config.operatorPayees });

  /**
   * Confirms with PayPal who owns each app before serving (DESIGN.md §21, D3), by the payee echo of a probe
   * order with no payee (getAppOwner; it is never approved and lapses). The operator app's owner must be
   * PAYPAL_OPERATOR_MERCHANT_ID and no guide's payee. Any other answer, or none, refuses to start, naming the
   * check that failed. userinfo, used before, has no payer_id for an app token (spike S11, 3 Nov).
   */
  let operatorIdentity: "pending" | "confirmed" | "config-only (unconfirmed)" = "pending";
  const optOut = "Set PAYPAL_OPERATOR_IDENTITY=config-only to run on the configured ids alone (unconfirmed).";
  /** The merchant id PayPal echoes as `client`'s owner; throws, naming `check`, when it can't be read. */
  async function appOwner(client: PaymentsApi, check: string, what: string): Promise<string> {
    let owner: string | undefined;
    try {
      owner = (await client.getAppOwner()).merchant_id;
    } catch (e) {
      throw new Error(`${check}: could not ask PayPal who owns ${what} (${e instanceof PayPalError ? e.summary() : "error"}); refusing to start. ${optOut}`);
    }
    if (!owner) throw new Error(`${check}: PayPal's probe order for ${what} echoes no payee merchant_id; refusing to start. ${optOut}`);
    return owner;
  }
  async function confirmOwners(): Promise<void> {
    if (config.operatorIdentityCheck === "config-only") {
      operatorIdentity = "config-only (unconfirmed)";
      log({ event: "operator_identity", status: operatorIdentity, warning: "PAYPAL_OPERATOR_MERCHANT_ID is trusted from config, not confirmed with PayPal" });
      return;
    }
    const check = "Operator identity check failed";
    const owner = await appOwner(payments, check, "the operator's REST app");
    if (!config.operatorPayees.some((p) => p.merchant_id === owner)) {
      throw new Error(`${check}: PayPal says the operator's REST app is owned by merchant ${owner}, which is not PAYPAL_OPERATOR_MERCHANT_ID; refusing to start`);
    }
    const guide = guides.find((g) => g.payee.merchant_id === owner);
    if (guide) throw new Error(`${check}: the operator's REST app is owned by merchant ${owner}, which is guide ${guide.id}'s payee; Ambree must never be the payee; refusing to start`);
    operatorIdentity = "confirmed";
    log({ event: "operator_identity", status: operatorIdentity, merchant_id: owner });
  }

  // Traveller sessions: an HttpOnly cookie holds a random id; the server maps it (stored hashed) to the
  // conversations it created. A conversation id is never accepted from the client.
  const sessions = new Records<{ id: string; conversations: string[] }>(db, "session");
  const secureCookie = config.publicUrl.startsWith("https://");
  const newConversationId = () => `cv_${randomBytes(12).toString("hex")}`;
  const sidHash = (sid: string) => createHash("sha256").update(`session:${sid}`).digest("hex");
  /** The caller's session if its cookie names one; never creates one. */
  function existingSession(req: IncomingMessage): { id: string; conversations: string[] } | undefined {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return sid && /^[A-Za-z0-9_-]{43}$/.test(sid) ? sessions.get(sidHash(sid)) : undefined;
  }
  function session(req: IncomingMessage, res: ServerResponse): { id: string; conversations: string[] } {
    let rec = existingSession(req);
    if (!rec) {
      const fresh = randomBytes(32).toString("base64url");
      rec = sessions.put({ id: sidHash(fresh), conversations: [] });
      res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureCookie ? "; Secure" : ""}`);
    }
    return rec;
  }
  /**
   * The conversation a tab names, if this session owns it. There is no session-wide "current"
   * conversation: each tab sends its own id, and an id the session doesn't own is refused (404).
   */
  function ownedConversation(req: IncomingMessage, res: ServerResponse, requested: unknown): string | undefined {
    if (typeof requested !== "string" || !/^cv_[0-9a-f]{24}$/.test(requested)) return undefined;
    return session(req, res).conversations.includes(requested) ? requested : undefined;
  }
  const publicOrigin = new URL(config.publicUrl).origin;
  /**
   * Checks for a state-changing browser request, run BEFORE any session work so a refused request never
   * creates or replaces a session: the body must be JSON (an HTML form can't send that cross-site without
   * a CORS preflight, which this server never grants), and an Origin header, when present, must be ours.
   */
  function refuseMutation(req: IncomingMessage, opts: { json: boolean }): { status: number; error: string } | undefined {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== publicOrigin) return { status: 403, error: "cross-origin request refused" };
    if (opts.json && !isJsonRequest(req)) return { status: 415, error: "Content-Type must be application/json" };
    return undefined;
  }
  const mcpConfigured = config.mcpPasscode ? Buffer.from(config.mcpPasscode) : undefined;
  function mcpAllowed(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? "";
    if (!mcpConfigured || !auth.startsWith("Bearer ")) return false;
    const given = Buffer.from(auth.slice(7));
    return given.length === mcpConfigured.length && timingSafeEqual(given, mcpConfigured);
  }
  const model: ChatModel =
    opts.model ?? (config.llm.mode === "openai" ? new OpenAICompatModel({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model }) : new ScriptedModel(today));
  const toolCtx = { service, channels, sendOperatorLink: channels.sendOperatorLink.bind(channels) };
  const agent = new Agent(model, toolCtx, today);

  const statics = Object.fromEntries(Object.entries(STATIC).map(([path, s]) => [path, { ...s, body: readFileSync(join(PUBLIC_DIR, s.file)) }]));

  async function runEvents(conv: string): Promise<string[]> {
    const replies: string[] = [];
    for (const e of channels.drain(conv)) replies.push((await agent.turn(conv, `[event] ${e.type} ${e.booking_id}: ${e.text}`)).reply);
    return replies;
  }

  function state(conv: string) {
    const bookings = service.forConversation(conv);
    const ids = new Set(bookings.map((b) => b.id));
    return {
      conversation_id: conv,
      mode: { paypal: config.paypal.mode, model: agent.modelLabel },
      transcript: agent.transcript(conv),
      pending_events: channels.pending(conv),
      bookings: bookings.map((b) => ({ ...service.summary(b), guide_balance: fake ? fake.balance(service.guide(b.guide_id)!.payee) : null })),
      inbox: channels.inbox(conv).map(({ text, at, mandate_id }) => ({ text, at, mandate_id })),
      guide_phone: channels.operatorLinks(conv),
      ledger: ledger.list().filter((e) => ids.has(e.booking_id)),
      chain: ledger.verify(checkpoint),
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && statics[path]) {
      if (path === "/") session(req, res);
      return send(res, 200, statics[path]!.body.toString("utf8"), statics[path]!.type);
    }
    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true, version: VERSION, paypal: config.paypal.mode, model: config.llm.mode, operator_identity: operatorIdentity });
    if (method === "GET" && path === "/api/ledger/head") return sendJson(res, 200, { ...checkpoint, verify: ledger.verify(checkpoint) });

    // State-changing browser routes: refused before any session is looked up, created or replaced.
    if (method === "POST") {
      const refused = path.startsWith("/api/") ? refuseMutation(req, { json: true }) : path.startsWith("/o/") || path.startsWith("/fake-paypal/") ? refuseMutation(req, { json: false }) : undefined;
      if (refused) return sendJson(res, refused.status, { error: refused.error });
    }

    // Every traveller route acts on a conversation the caller's session owns, named by the tab.
    const noConversation = () => sendJson(res, 404, { error: "unknown conversation" });
    if (path === "/api/chat" && method === "POST") {
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { error: "JSON body required" });
      const conv = ownedConversation(req, res, body.conversation_id);
      if (!conv) return noConversation();
      const replies = await runEvents(conv);
      if (typeof body.message === "string" && body.message.trim()) replies.push((await agent.turn(conv, body.message.trim())).reply);
      return sendJson(res, 200, { replies, ...state(conv) });
    }
    if (path === "/api/state" && method === "GET") {
      const conv = ownedConversation(req, res, url.searchParams.get("conversation_id"));
      return conv ? sendJson(res, 200, state(conv)) : noConversation();
    }
    if (path === "/api/conversations" && method === "POST") {
      const s = session(req, res);
      const conv = newConversationId();
      sessions.put({ id: s.id, conversations: [...s.conversations, conv].slice(-20) });
      return sendJson(res, 200, state(conv));
    }
    let m = path.match(/^\/api\/mandates\/(md_[0-9a-f]{16})\/approve$/);
    if (m && method === "POST") {
      const body = await readJson(req);
      const s = session(req, res);
      const mandate = mandates.get(m[1]!);
      const booking = mandate ? service.get(mandate.booking_id) : undefined;
      if (!booking || !s.conversations.includes(booking.conversation_id)) return sendJson(res, 404, { error: "No such mandate." });
      try {
        await service.approveMandate(m[1]!, String(body?.code ?? ""));
        return sendJson(res, 200, { ok: true, ...state(booking.conversation_id) });
      } catch (e) {
        if (e instanceof ServiceError) return sendJson(res, 422, { ok: false, error: e.message, reason: e.code });
        throw e;
      }
    }
    if (path === "/api/demo/cyclone" && method === "POST") {
      // The demo cyclone control, past the Origin and Content-Type checks above. It needs an existing
      // session (it never creates one) and never calls PayPal. Live PayPal can't get here: config and the
      // REST client refuse any base URL but the sandbox's, before the server starts.
      const s = existingSession(req);
      if (!s) return sendJson(res, 401, { error: "No session: open the page first." });
      if (!fake) {
        // Sandbox (the hosted demo): a simulated warning for one booking the caller's session owns, once.
        const body = await readJson(req);
        const id = body?.booking_id;
        const b = typeof id === "string" && /^bk_[0-9a-f]{12}$/.test(id) ? service.get(id) : undefined;
        if (!b || !s.conversations.includes(b.conversation_id)) return sendJson(res, 404, { error: "No such booking." });
        try {
          const r = await service.simulateCyclone(b.id);
          log({ event: "demo_cyclone", booking: b.id, posted: r.posted });
          return sendJson(res, 200, { ok: true, simulated: true, posted: r.posted, booking_id: b.id, date: r.booking.simulated_alert!.from, bookings_warned: r.posted ? 1 : 0 });
        } catch (e) {
          if (e instanceof ServiceError) return sendJson(res, 409, { ok: false, error: e.message, reason: e.code });
          throw e;
        }
      }
      // Fake mode (offline demo), unchanged: a demo-feed warning around every booking of the tab's conversation.
      const conv = ownedConversation(req, res, (await readJson(req))?.conversation_id);
      if (!conv) return noConversation();
      const dates = service.forConversation(conv).map((b) => b.date).sort();
      if (!dates.length) return sendJson(res, 400, { error: "no booking to warn about" });
      weather.raise({ id: `TC-DEMO-${Date.now()}`, name: "Cyclone Demo-1 (demo)", level: "orange", from: addDays(dates[0]!, -1), to: addDays(dates.at(-1)!, 1), summary: "Demo warning raised from the page." });
      const n = await service.announceCyclone(conv);
      return sendJson(res, 200, { ok: true, bookings_warned: n });
    }

    m = path.match(/^\/o\/([A-Za-z0-9_-]{43})$/);
    if (m) {
      const token = m[1]!;
      const booking = service.byToken(token);
      if (!booking) return send(res, 404, renderInvalidLink(), "text/html; charset=utf-8");
      if (method === "POST") {
        const raw = await readBody(req, JSON_LIMIT);
        const flash = await applyOperatorAction(service, token, new URLSearchParams(raw ?? ""));
        return send(res, flash.ok ? 200 : 422, renderOperatorPage(token, service.get(booking.id)!, flash), "text/html; charset=utf-8");
      }
      return send(res, 200, renderOperatorPage(token, booking), "text/html; charset=utf-8");
    }
    if (path.startsWith("/o/")) return send(res, 404, renderInvalidLink(), "text/html; charset=utf-8");

    if (path === "/paypal/return" && method === "GET") {
      // Captures only for the session that owns the booking (the traveller's browser carries the cookie on
      // this top-level redirect). Anyone else just lands on "/"; the webhook still captures. Never a
      // conversation id in the URL.
      const id = url.searchParams.get("booking") ?? "";
      const b = service.get(id);
      if (b && session(req, res).conversations.includes(b.conversation_id)) {
        try {
          const r = await service.captureIfApproved(id);
          log({ event: "return", booking: id, captured: r.captured, order_status: r.order_status });
        } catch (e) {
          log({ event: "return_failed", booking: id, error: e instanceof Error ? e.name : "unknown" });
        }
      }
      return redirect(res, "/");
    }
    if (path === "/paypal/cancel" && method === "GET") return redirect(res, "/");

    if (path === "/webhooks/paypal" && method === "POST") {
      const raw = await readBody(req, WEBHOOK_LIMIT);
      if (raw === undefined) return sendJson(res, 413, { error: "too large" });
      const r = await service.handleWebhook(raw, req.headers);
      log({ event: "webhook", status: r.status, result: r.result });
      return sendJson(res, r.status, { result: r.result });
    }

    if (path === "/mcp") {
      // MCP clients share the "mcp" conversation, which no web session owns, so they can't reach a
      // traveller's bookings; and MCP is off unless MCP_DEMO_PASSCODE is set and sent as a Bearer token.
      if (!mcpAllowed(req)) return sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: config.mcpPasscode ? "Unauthorized: send the demo passcode as a Bearer token" : "MCP is disabled on this instance" }, id: null });
      if (method !== "POST") return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: stateless server, POST only" }, id: null });
      const raw = await readBody(req, MCP_LIMIT);
      let body: unknown;
      try {
        body = JSON.parse(raw ?? "");
      } catch {
        return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
      }
      return handleMcp(req, res, body, toolCtx, VERSION);
    }

    if (fake && path === "/fake-paypal/checkout") {
      const orderId = url.searchParams.get("token") ?? "";
      const order = /^[A-Z0-9]{17}$/.test(orderId) ? fake.order(orderId) : undefined;
      if (!order) return send(res, 404, "No such order", "text/plain");
      const unit = order.purchase_units![0]!;
      if (method === "POST") {
        if (order.status === "PAYER_ACTION_REQUIRED" || order.status === "CREATED") fake.approve(orderId);
        return redirect(res, `${config.publicUrl}/paypal/return?booking=${encodeURIComponent(unit.custom_id ?? "")}&token=${orderId}`);
      }
      return send(
        res,
        200,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake PayPal checkout</title><link rel="stylesheet" href="/style.css"></head>
<body class="operator"><main><p class="tag">Stand-in for PayPal sandbox checkout (offline demo; no real PayPal call)</p><h1>Pay ${esc(formatMoney(unit.amount))}</h1>
<section class="card"><dl><dt>To (payee)</dt><dd data-testid="fake-payee">${esc(unit.payee?.email_address ?? unit.payee?.merchant_id ?? "app owner")}</dd><dt>For</dt><dd>${esc(unit.description)}</dd><dt>Order</dt><dd class="mono">${esc(order.id)} · ${esc(order.status)}</dd></dl>
<form method="post"><button type="submit" data-action="fake-approve">Approve as the sandbox traveller</button></form></section></main></body></html>`,
        "text/html; charset=utf-8",
      );
    }

    return sendJson(res, 404, { error: "not found" });
  }

  const server = createServer((req, res) => {
    securityHeaders(res);
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return sendJson(res, 400, { error: "bad url" });
    }
    route(req, res, url)
      .catch((e: unknown) => {
        log({ event: "error", path: redactPath(url.pathname), error: e instanceof Error ? e.name : "unknown" });
        if (!res.headersSent) sendJson(res, e instanceof ServiceError ? 422 : 500, { error: e instanceof ServiceError ? e.message : "internal error" });
      })
      .finally(() => log({ event: "request", method: req.method, path: redactPath(url.pathname), status: res.statusCode, ms: Date.now() - started }));
  });

  return {
    server,
    service,
    fake,
    listen: async () => {
      await confirmOwners();
      return new Promise<number>((resolve) => {
        server.listen(config.port, config.host, () => {
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      });
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
