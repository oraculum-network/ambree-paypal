// Round 2: cross-site POSTs are refused without touching the session; conversations are per tab.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, startApp } from "./helpers/server.ts";

let s: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  s = await startApp();
});
afterAll(async () => {
  await s?.app.close();
});

describe("round 2: cross-site POST", () => {
  it("a form POST without a cookie is refused and sets no cookie", async () => {
    for (const path of ["/api/conversations", "/api/chat", "/api/demo/cyclone", "/api/mandates/md_0000000000000000/approve"]) {
      const res = await fetch(`${s.base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "message=hi", redirect: "manual" });
      expect(res.status, path).toBe(415);
      expect(res.headers.getSetCookie(), path).toEqual([]);
    }
  });

  it("a JSON POST from another origin is refused and sets no cookie", async () => {
    const res = await fetch(`${s.base}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("an operator-page POST from another origin is refused (forms stay form-encoded there)", async () => {
    const a = new Browser(s.base);
    const first = await a.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday" });
    const link = first.guide_phone[0].url as string;
    const form = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, body: "action=decline" };
    expect((await fetch(link, form)).status).toBe(403);
    expect((await a.json("/api/state")).bookings[0].status).toBe("requested");
  });

  it("the configured origin is accepted, and the traveller keeps their session", async () => {
    const a = new Browser(s.base);
    const conv = await a.json("/api/conversations", {});
    expect(conv.conversation_id).toMatch(/^cv_[0-9a-f]{24}$/);
    const cookie = a.cookie;
    const res = await a.fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json", Origin: s.base }, body: "{}" });
    expect(res.status).toBe(200);
    expect(a.cookie).toBe(cookie);
  });
});

describe("round 2: per-tab conversations", () => {
  it("a new conversation in tab B leaves tab A on its own", async () => {
    const browser = new Browser(s.base);
    const tabA = (await browser.json("/api/conversations", {})).conversation_id as string;
    const first = await browser.json("/api/chat", { conversation_id: tabA, message: "Find me a hiking guide for Le Morne on Thursday" });
    expect(first.conversation_id).toBe(tabA);
    expect(first.bookings).toHaveLength(1);
    const tabB = (await browser.json("/api/conversations", {})).conversation_id as string;
    expect(tabB).not.toBe(tabA);
    const a = await browser.json(`/api/state?conversation_id=${tabA}`);
    expect(a.bookings).toHaveLength(1);
    const b = await browser.json("/api/chat", { conversation_id: tabB, message: "hello" });
    expect(b.bookings).toHaveLength(0);
    expect((await browser.json(`/api/state?conversation_id=${tabA}`)).bookings).toHaveLength(1);
  });

  it("a conversation id the session doesn't own is refused", async () => {
    const owner = new Browser(s.base);
    const conv = (await owner.json("/api/conversations", {})).conversation_id as string;
    const other = new Browser(s.base);
    await other.json("/api/conversations", {});
    const res = await other.fetch(`/api/state?conversation_id=${conv}`);
    expect(res.status).toBe(404);
    const chat = await other.fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: conv, message: "hi" }) });
    expect(chat.status).toBe(404);
  });
});
