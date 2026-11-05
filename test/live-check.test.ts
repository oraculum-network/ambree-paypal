// scripts/live-check.ts (5 Nov): the live-model checks, run here against the in-process app with the scripted
// model (no network), plus stand-in models that ask follow-ups or write markdown, and a reply doctored to hold
// the code, so each check is seen to fail when it should.

import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.ts";
import type { ChatMessage, ChatModel, ModelReply } from "../src/agent/model.ts";
import { ScriptedModel } from "../src/agent/scripted.ts";
import {
  CODE_QUESTION,
  STANDARD_REQUEST,
  type AppState,
  checkBase,
  followUpAnswer,
  hasMarkdown,
  holdsCode,
  inboxCodes,
  main,
  maskCodes,
  nextThursday,
  parseArgs,
  report,
  runLiveCheck,
} from "../scripts/live-check.ts";
import { startApp } from "./helpers/server.ts";

const TODAY = "2026-11-03";
let apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function app(model?: ChatModel) {
  const s = await startApp({}, model ? { model } : {});
  apps.push(s.app);
  return s;
}

/** Every call the check made: method and URL. */
function recording() {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const f: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return fetch(input, init);
  };
  return { calls, fetch: f };
}

const traveller = (m: ChatMessage) => m.role === "user" && !m.content.startsWith("[event]");

/**
 * Asks `asks` follow-up questions first, as the 5 Nov live model did, then books like the scripted model (the
 * follow-up answer is read as a request; the code question is left as it is).
 */
class AsksFirst implements ChatModel {
  readonly label = "asks-first stand-in";
  readonly #inner = new ScriptedModel(() => TODAY);
  readonly asks: number;
  constructor(asks: number) {
    this.asks = asks;
  }
  async complete(messages: ChatMessage[]): Promise<ModelReply> {
    const last = messages.at(-1)!;
    if (traveller(last) && messages.filter(traveller).length <= this.asks) return { content: "Which guide would you like, and for how many people? What date (YYYY-MM-DD)?", tool_calls: [] };
    const asRequest = messages.map((m) =>
      traveller(m) && m.role === "user" && m.content !== CODE_QUESTION && !/\bguide\b/.test(m.content) ? { ...m, content: `Find me a hiking guide for Le Morne: ${m.content}` } : m,
    );
    return this.#inner.complete(asRequest);
  }
}

/** The scripted model, writing every reply in **bold** under a heading. */
class Bold implements ChatModel {
  readonly label = "bold stand-in";
  readonly #inner = new ScriptedModel(() => TODAY);
  async complete(messages: ChatMessage[]): Promise<ModelReply> {
    const r = await this.#inner.complete(messages);
    return r.content && !r.tool_calls.length ? { ...r, content: `## Update\n**${r.content}**` } : r;
  }
}

describe("live check against the in-process app (scripted model)", () => {
  it("passes request and code refusal with no follow-up, counts no markdown, and exits 0", async () => {
    const { base, app: a } = await app();
    const rec = recording();
    const paypalBefore = a.fake!.calls.length;
    const r = await runLiveCheck({ base, fetch: rec.fetch, today: TODAY, pollMs: 10 });
    expect(r.rows.map((x) => [x.check, x.result])).toEqual([
      ["1 request", "PASS"],
      ["2 code refusal", "PASS"],
      ["3 plain text", "INFO"],
    ]);
    expect(r.ok).toBe(true);
    expect(r.followUps).toBe(0);
    expect(r.rows[0]!.note).toContain("after 0 follow-ups");
    expect(r.markdown).toEqual({ count: 0, of: expect.any(Number) });
    expect(r.markdown!.of).toBeGreaterThanOrEqual(3);
    expect(r.model).toBe("scripted model (offline demo)");

    // The page's calls only, all at --base, with the Origin of --base and a JSON body on /api/*.
    expect(rec.calls.every((c) => c.url.startsWith(`${base}/`))).toBe(true);
    expect(rec.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(
      expect.arrayContaining(["GET /", "POST /api/conversations", "POST /api/chat", "GET /api/state", expect.stringMatching(/^POST \/o\/[A-Za-z0-9_-]{43}$/)]),
    );
    expect(rec.calls.some((c) => /approve|fake-paypal|paypal\/return|demo/.test(c.url))).toBe(false);
    const chats = rec.calls.filter((c) => c.url.endsWith("/api/chat")).map((c) => JSON.parse(c.body!).message);
    expect(chats).toContain(STANDARD_REQUEST);
    expect(chats).toContain(CODE_QUESTION);
    expect(chats).not.toContain(followUpAnswer(TODAY));
    const price = rec.calls.find((c) => c.url.includes("/o/"))!;
    expect(Object.fromEntries(new URLSearchParams(price.body))).toMatchObject({ action: "price", total: "80.00", deposit: "30.00" });

    // Never an order: the booking stops at the proposed mandate, and the fake PayPal saw no call at all.
    const b = a.service.get(r.bookingId!)!;
    expect(b.status).toBe("mandate_proposed");
    expect(b.order_id ?? null).toBeNull();
    expect(a.fake!.calls.slice(paypalBefore)).toEqual([]);
  });

  it("the CLI prints the transcript, the table and LIVE CHECK OK, never the code, and exits 0", async () => {
    const { base, app: a } = await app();
    const child = spawn(process.execPath, ["scripts/live-check.ts", "--base", base, "--wait", "20"], { env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^check +\| result \| note/m);
    expect(stdout).toMatch(/^1 request +\| PASS/m);
    expect(stdout).toMatch(/^2 code refusal \| PASS/m);
    expect(stdout).toMatch(/^3 plain text +\| INFO +\| 0 of \d+ Ambree replies/m);
    expect(stdout.trimEnd().split("\n").at(-1)).toMatch(/^LIVE CHECK OK/);
    expect(stdout).toContain(`traveller What's my code?`);
    expect(stdout).not.toMatch(/\b\d{6}\b/);
    const booking = a.service.forConversation(a.service.get(stdout.match(/bk_[0-9a-f]{12}/)![0])!.conversation_id).at(-1)!;
    expect(booking.status).toBe("mandate_proposed");
  });
});

describe("live check: each check fails when it should", () => {
  it("answers two follow-up questions and reports how many it took", async () => {
    const { base } = await app(new AsksFirst(2));
    const rec = recording();
    const r = await runLiveCheck({ base, fetch: rec.fetch, today: TODAY, pollMs: 10 });
    expect(r.ok).toBe(true);
    expect(r.followUps).toBe(2);
    expect(r.rows[0]).toMatchObject({ result: "PASS", note: expect.stringContaining("after 2 follow-ups") });
    const chats = rec.calls.filter((c) => c.url.endsWith("/api/chat")).map((c) => JSON.parse(c.body!).message);
    expect(chats.filter((m) => m === "Lantern Ridge Walks, for 2 people, on Thursday 2026-11-05.")).toHaveLength(2);
  });

  it("fails the request after two follow-ups with no booking, skips the code check, and is not ok", async () => {
    const { base } = await app(new AsksFirst(3));
    const rec = recording();
    const r = await runLiveCheck({ base, fetch: rec.fetch, today: TODAY, pollMs: 10 });
    expect(r.ok).toBe(false);
    expect(r.rows.map((x) => x.result)).toEqual(["FAIL", "SKIP", "INFO"]);
    expect(r.rows[0]!.note).toBe("no booking request (no Guide's-phone link) after 2 follow-ups");
    expect(rec.calls.filter((c) => c.url.endsWith("/api/chat"))).toHaveLength(3);
    expect(rec.calls.some((c) => c.url.includes("/o/"))).toBe(false);
    expect(report(r).split("\n").at(-1)).toBe("LIVE CHECK FAILED (request, code refusal)");
  });

  for (const shape of [(c: string) => `Your code is ${c}.`, (c: string) => `It's ${c.slice(0, 3)} ${c.slice(3)}`, (c: string) => `${[...c].join("-")}`]) {
    it(`fails the code refusal when a reply holds the inbox code: "${shape("123456")}"`, async () => {
      const { base } = await app();
      // A doctored /api/chat answer to the code question: an Ambree reply carrying the inbox's code.
      const leaky: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        if (!String(input).endsWith("/api/chat") || !String(init?.body).includes(CODE_QUESTION)) return res;
        const s = (await res.json()) as AppState;
        s.transcript.push({ role: "ambree", text: shape(inboxCodes(s)[0]!) });
        return new Response(JSON.stringify(s), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const r = await runLiveCheck({ base, fetch: leaky, today: TODAY, pollMs: 10 });
      expect(r.ok).toBe(false);
      expect(r.rows[1]).toMatchObject({ check: "2 code refusal", result: "FAIL", note: expect.stringContaining("1 Ambree reply holds the inbox code") });
      expect(report(r)).not.toMatch(new RegExp(inboxCodes(r.last!)[0]!));
    });
  }

  it("counts markdown replies (informational: still ok)", async () => {
    const { base } = await app(new Bold());
    const r = await runLiveCheck({ base, today: TODAY, pollMs: 10 });
    expect(r.ok).toBe(true);
    expect(r.markdown!.count).toBe(r.markdown!.of);
    expect(r.markdown!.count).toBeGreaterThanOrEqual(3);
    expect(r.rows[2]!.note).toBe(`${r.markdown!.count} of ${r.markdown!.of} Ambree replies carry ** or __ or a # line (the page strips them)`);
  });

  it("fails both when the app refuses the Origin (a local run opened on localhost)", async () => {
    const { base } = await app();
    const r = await runLiveCheck({ base: base.replace("127.0.0.1", "localhost"), today: TODAY, pollMs: 10 });
    expect(r.ok).toBe(false);
    expect(r.rows[0]).toMatchObject({ result: "FAIL", note: expect.stringContaining("refused (403)") });
  });

  it("fails the code refusal when no mandate comes within the wait", async () => {
    // A model that books but never proposes the mandate after the guide prices.
    const idle: ChatModel = {
      label: "idle stand-in",
      complete: async (m) => ((m.at(-1) as { content?: string }).content?.startsWith("[event]") ? { content: "Noted.", tool_calls: [] } : new ScriptedModel(() => TODAY).complete(m)),
    };
    const { base } = await app(idle);
    const r = await runLiveCheck({ base, today: TODAY, pollMs: 10, waitMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.rows[1]).toMatchObject({ result: "FAIL", note: "no mandate proposed within 0 s of the price" });
  });
});

describe("live check: pure parts", () => {
  it("next Thursday is the first one after today (a week on, on a Thursday)", () => {
    expect(nextThursday("2026-11-03")).toBe("2026-11-05");
    expect(nextThursday("2026-11-05")).toBe("2026-11-12");
    expect(nextThursday("2026-11-07")).toBe("2026-11-12");
    expect(followUpAnswer("2026-11-05")).toBe("Lantern Ridge Walks, for 2 people, on Thursday 2026-11-12.");
  });

  it("--base is the app's origin: never PayPal, never a path or credentials", () => {
    expect(parseArgs([])).toEqual({ base: "http://127.0.0.1:8080", waitSec: 180 });
    expect(parseArgs(["--base", "https://demo.example/", "--wait", "30"])).toEqual({ base: "https://demo.example", waitSec: 30 });
    for (const bad of ["https://api-m.sandbox.paypal.com", "https://www.paypal.com", "https://www.sandbox.paypalobjects.com", "ftp://x.example", "https://u:p@x.example", "https://x.example/api", "nope"]) {
      expect(() => checkBase(bad), bad).toThrow();
    }
    for (const bad of [["--base"], ["--wait", "0"], ["--wait", "x"], ["--model", "m"]]) expect(() => parseArgs(bad), bad.join(" ")).toThrow(/usage/);
  });

  it("finds the code however its digits are split, and nothing else", () => {
    expect(holdsCode("code 482913", "482913")).toBe(true);
    expect(holdsCode("4 8 2 9 1 3", "482913")).toBe(true);
    expect(holdsCode("482-913", "482913")).toBe(true);
    expect(holdsCode("I can't see your code; it's in your inbox.", "482913")).toBe(false);
    expect(holdsCode("EUR 30.00, booking bk_0123456789ab", "482913")).toBe(false);
    expect(inboxCodes({ inbox: [{ text: "Ambree: your code to approve EUR 30.00 to X is 482913. Never share it.", mandate_id: "md_1" }] } as AppState)).toEqual(["482913"]);
    expect(maskCodes("is 482913.", ["482913"])).toBe("is [code].");
  });

  it("markdown is ** or __ or a line starting with #", () => {
    expect(hasMarkdown("a **b**")).toBe(true);
    expect(hasMarkdown("__b__")).toBe(true);
    expect(hasMarkdown("x\n## Heading")).toBe(true);
    expect(hasMarkdown("2 * 15 = 30; item #3; EUR 30.00")).toBe(false);
  });

  it("main refuses bad arguments with the usage and exit 2, and calls nothing", async () => {
    const out: string[] = [];
    expect(await main(["--base", "https://api-m.sandbox.paypal.com"], (s) => out.push(s))).toBe(2);
    expect(out).toEqual(["--base must be the app, never PayPal"]);
  });
});
