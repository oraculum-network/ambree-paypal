// Finding 1: a conversation id or booking id must not be traveller authority.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTool } from "../src/tools/registry.ts";
import { Browser, startApp } from "./helpers/server.ts";
import { makeWorld } from "./helpers/world.ts";

let s: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  s = await startApp({ MCP_DEMO_PASSCODE: "demo-pass-123" });
});
afterAll(async () => {
  await s?.app.close();
});

// Old clients sent their own conversation id; the server must now ignore it.
const A_CONV = "cv_traveller_a01";

async function travellerWithMandate() {
  const a = new Browser(s.base);
  await a.json(`/api/state?conversation_id=${A_CONV}`);
  const first = await a.json("/api/chat", { conversation_id: A_CONV, message: "Find me a hiking guide for Le Morne on Thursday" });
  const link = first.guide_phone[0].url as string;
  await fetch(link, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ action: "price", total: "80", deposit: "30" }) });
  let st: Record<string, any> = {};
  for (let i = 0; i < 50; i++) {
    st = await a.json("/api/chat", { conversation_id: A_CONV });
    if (st.bookings?.[0]?.status === "mandate_proposed") break;
  }
  const bookingId = st.bookings[0].booking_id as string;
  const mandateId = st.bookings[0].mandate.id as string;
  const code = (st.inbox.at(-1).text as string).match(/\b(\d{6})\b/)![1]!;
  return { a, bookingId, mandateId, code };
}

describe("finding 1: traveller authority", () => {
  it("the session cookie is HttpOnly and SameSite=Lax", async () => {
    const res = await fetch(`${s.base}/api/state`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("amb_sid="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("the cookie is Secure on an https PUBLIC_URL", async () => {
    const t = await startApp({ PUBLIC_URL: "https://paypal.ambree.ai" });
    try {
      const res = await fetch(`${t.base}/api/state`);
      expect(res.headers.getSetCookie().find((c) => c.startsWith("amb_sid="))).toMatch(/; Secure/);
    } finally {
      await t.app.close();
    }
  });

  it("another session can't read, approve or learn the conversation", async () => {
    const { bookingId, mandateId, code } = await travellerWithMandate();
    const b = new Browser(s.base);
    const cancel = await b.fetch(`/paypal/cancel?booking=${bookingId}`);
    expect(cancel.headers.get("location")).toBe("/");
    const ret = await b.fetch(`/paypal/return?booking=${bookingId}`);
    expect(ret.headers.get("location")).toBe("/");

    const st = await b.json(`/api/state?conversation_id=${A_CONV}`);
    expect(st.bookings ?? []).toHaveLength(0);
    expect(JSON.stringify(st)).not.toContain(code);
    expect(JSON.stringify(st)).not.toContain(bookingId);

    const approve = await b.fetch(`/api/mandates/${mandateId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: A_CONV, code }) });
    expect(approve.status).toBe(404);
  });

  it("tools refuse a booking from another conversation", async () => {
    const w = makeWorld();
    const ctx = (conversationId: string) => ({ service: w.service, channels: w.channels, conversationId, sendOperatorLink: () => {} });
    const q = await runTool("request_quote", { guide_id: "g_lantern", date: "2026-11-05", party_size: 2, activity: "hike" }, ctx("cv_owner_00001"));
    expect(q.ok).toBe(true);
    const id = (q as unknown as { value: { booking_id: string } }).value.booking_id;
    for (const tool of ["get_booking", "propose_mandate", "create_order", "get_order", "capture_order", "check_weather", "refund_payment"]) {
      const r = await runTool(tool, { booking_id: id }, ctx("cv_intruder_001"));
      expect(r, tool).toMatchObject({ ok: false });
      expect((r as { message: string }).message, tool).toMatch(/^not_found/);
    }
    expect(await runTool("propose_reschedule", { booking_id: id, new_date: "2026-11-09" }, ctx("cv_intruder_001"))).toMatchObject({ ok: false });
  });

  it("MCP needs the demo passcode and can't reach web bookings", async () => {
    const { bookingId } = await travellerWithMandate();
    const noAuth = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(noAuth.status).toBe(401);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { Authorization: "Bearer demo-pass-123" } } }));
    const r = await client.callTool({ name: "get_booking", arguments: { booking_id: bookingId } });
    expect(r.isError).toBe(true);
    const c = await client.callTool({ name: "create_order", arguments: { booking_id: bookingId } });
    expect(c.isError).toBe(true);
    await client.close();
  });

  it("MCP is off when no passcode is configured", async () => {
    const t = await startApp();
    try {
      const res = await fetch(`${t.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(res.status).toBe(401);
    } finally {
      await t.app.close();
    }
  });
});
