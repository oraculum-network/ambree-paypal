// Judge polish (4 Nov): the guide's page is POST, then redirect, then GET. A form post applies the guide's
// answer and answers 303 to the same page (no query string); the answer's message is kept on the server,
// keyed by the token, and the next GET shows it once. So reloading the tab is a GET: the browser doesn't ask
// to resubmit, and nothing is applied twice.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderOperatorPage } from "../src/operator/page.ts";
import { Browser, startApp } from "./helpers/server.ts";

const REQUEST = "Find me a hiking guide for Le Morne on Thursday and hold the spot";
type Started = Awaited<ReturnType<typeof startApp>>;
type State = Record<string, any>;

/** A new tab with one requested booking: its guide link, the link's path and token, and the booking id. */
async function newBooking(s: Started) {
  const tab = new Browser(s.base);
  const first = await tab.json("/api/chat", { message: REQUEST });
  const link = first.guide_phone[0].url as string;
  const path = new URL(link).pathname;
  return { tab, link, path, token: path.split("/o/")[1]!, id: first.bookings[0].booking_id as string };
}

/** The page's own form post, without following the redirect. */
function post(link: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(link, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields), redirect: "manual" });
}

const FLASH_RE = /\n?<p class="flash (ok|err)" role="status">([^<]*)<\/p>/g;
/** Every flash paragraph on a page (there is at most one). */
function flashes(html: string): Array<{ ok: boolean; text: string }> {
  return [...html.matchAll(FLASH_RE)].map((m) => ({ ok: m[1] === "ok", text: m[2]! }));
}

async function get(link: string): Promise<{ status: number; html: string }> {
  const res = await fetch(link, { redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

const ledgerOf = async (tab: Browser) => ((await tab.json("/api/state")).ledger as State[]).map((e) => e.kind as string);

describe("the guide's page: POST, then 303, then GET", () => {
  let s: Started;
  beforeAll(async () => {
    s = await startApp();
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("a price answers 303 to the same page with no query string; the GET shows the message once, and a reload applies nothing again", async () => {
    const b = await newBooking(s);
    // As a browser posts the page's form: with our own Origin.
    const res = await post(b.link, { action: "price", total: "80", deposit: "30" }, { Origin: s.base });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/o/${b.token}`);
    expect(await res.text()).toBe("");
    expect(s.app.service.get(b.id)!.status).toBe("priced");

    const first = await get(b.link);
    expect(first.status).toBe(200);
    expect(flashes(first.html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
    expect(first.html).toContain("Your quote");
    const ledger = await ledgerOf(b.tab);
    expect(ledger.filter((k) => k === "quote.priced")).toHaveLength(1);
    const pending = (await b.tab.json("/api/state")).pending_events as number;

    // The reload: a GET, with no message, rendered exactly as a page with nothing pending; nothing applied.
    const reload = await get(b.link);
    expect(reload.status).toBe(200);
    expect(flashes(reload.html)).toEqual([]);
    expect(reload.html).toBe(renderOperatorPage(b.token, s.app.service.get(b.id)!));
    expect(reload.html).toBe(first.html.replace(FLASH_RE, ""));
    expect(await ledgerOf(b.tab)).toEqual(ledger);
    expect((await b.tab.json("/api/state")).pending_events).toBe(pending);
    expect(s.app.service.get(b.id)!.status).toBe("priced");
  });

  it("a refused answer is a 303 too; its error shows once, then the page is plain again", async () => {
    const b = await newBooking(s);
    expect((await post(b.link, { action: "price", total: "80", deposit: "30" })).status).toBe(303);
    expect(flashes((await get(b.link)).html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
    const ledger = await ledgerOf(b.tab);

    const again = await post(b.link, { action: "price", total: "90", deposit: "10" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(`/o/${b.token}`);
    const shown = await get(b.link);
    expect(shown.status).toBe(200);
    expect(flashes(shown.html)).toEqual([{ ok: false, text: "This request already has an answer." }]);
    expect(shown.html).toContain('class="flash err"');
    const plain = await get(b.link);
    expect(flashes(plain.html)).toEqual([]);
    expect(plain.html).toBe(renderOperatorPage(b.token, s.app.service.get(b.id)!));
    expect(await ledgerOf(b.tab)).toEqual(ledger);
    expect(s.app.service.get(b.id)!.quote!.total).toMatchObject({ value: "80.00" });

    const unknown = await post(b.link, { action: "nope" });
    expect(unknown.status).toBe(303);
    expect(flashes((await get(b.link)).html)).toEqual([{ ok: false, text: "Unknown action." }]);
    expect(flashes((await get(b.link)).html)).toEqual([]);
  });

  it("two links' messages don't mix", async () => {
    const a = await newBooking(s);
    const b = await newBooking(s);
    expect((await post(a.link, { action: "price", total: "80", deposit: "30" })).status).toBe(303);
    // B's page, before B has answered: nothing of A's.
    expect(flashes((await get(b.link)).html)).toEqual([]);
    expect((await post(b.link, { action: "decline" })).status).toBe(303);
    expect(flashes((await get(b.link)).html)).toEqual([{ ok: true, text: "Declined. The traveller will be told." }]);
    expect(flashes((await get(a.link)).html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
    expect(flashes((await get(a.link)).html)).toEqual([]);
    expect(flashes((await get(b.link)).html)).toEqual([]);
    expect(s.app.service.get(a.id)!.status).toBe("priced");
    expect(s.app.service.get(b.id)!.status).toBe("declined");
  });

  it("only a GET takes the message: a HEAD leaves it for the GET", async () => {
    const b = await newBooking(s);
    expect((await post(b.link, { action: "price", total: "80", deposit: "30" })).status).toBe(303);
    expect((await fetch(b.link, { method: "HEAD" })).status).toBe(200);
    expect(flashes((await get(b.link)).html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
  });

  it("kept: an unknown or malformed token gets the invalid-link page (404) before any action, and no redirect", async () => {
    for (const path of [`/o/${"A".repeat(43)}`, "/o/not-a-token"]) {
      const res = await post(`${s.base}${path}`, { action: "price", total: "80", deposit: "30" });
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
      expect(await res.text(), path).toContain("This link is not valid");
    }
  });

  it("kept: a cross-origin post is refused (403) as before, applies nothing and leaves no message", async () => {
    const b = await newBooking(s);
    const res = await post(b.link, { action: "decline" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(s.app.service.get(b.id)!.status).toBe("requested");
    expect(flashes((await get(b.link)).html)).toEqual([]);
  });
});

describe("the messages kept for the guide's page are capped", () => {
  let s: Started;
  beforeAll(async () => {
    s = await startApp({}, { flashLimit: 2 });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("over the cap, the oldest message goes first; the newest are still shown", async () => {
    const a = await newBooking(s);
    const b = await newBooking(s);
    const c = await newBooking(s);
    for (const x of [a, b, c]) expect((await post(x.link, { action: "price", total: "80", deposit: "30" })).status).toBe(303);
    expect(flashes((await get(a.link)).html)).toEqual([]);
    expect(flashes((await get(b.link)).html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
    expect(flashes((await get(c.link)).html)).toEqual([{ ok: true, text: "Price sent to the traveller." }]);
    // The answer itself was applied for all three; only A's message was dropped.
    for (const x of [a, b, c]) expect(s.app.service.get(x.id)!.status).toBe("priced");
  });

  it("the store: a fixed default cap, oldest out first, a new message for a token replaces its old one", async () => {
    const { Flashes, FLASH_LIMIT } = await import("../src/operator/flash.ts");
    expect(Number.isInteger(FLASH_LIMIT) && FLASH_LIMIT > 0).toBe(true);
    const store = new Flashes();
    for (let i = 0; i < FLASH_LIMIT + 5; i++) store.put(`t${i}`, { ok: true, text: `m${i}` });
    expect(store.size).toBe(FLASH_LIMIT);
    for (let i = 0; i < 5; i++) expect(store.take(`t${i}`)).toBeUndefined();
    expect(store.take(`t${FLASH_LIMIT + 4}`)).toEqual({ ok: true, text: `m${FLASH_LIMIT + 4}` });
    expect(store.take(`t${FLASH_LIMIT + 4}`)).toBeUndefined();
    expect(store.size).toBe(FLASH_LIMIT - 1);

    const small = new Flashes(2);
    small.put("x", { ok: true, text: "x1" });
    small.put("y", { ok: true, text: "y1" });
    small.put("x", { ok: false, text: "x2" }); // x is now the newest, and counted once
    expect(small.size).toBe(2);
    small.put("z", { ok: true, text: "z1" }); // y, the oldest, goes
    expect(small.take("y")).toBeUndefined();
    expect(small.take("x")).toEqual({ ok: false, text: "x2" });
    expect(small.take("z")).toEqual({ ok: true, text: "z1" });
    expect(() => new Flashes(0)).toThrow();
  });
});
