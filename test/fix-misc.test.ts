// Findings 8-10: path redaction in every log line, the ledger checkpoint, the spike's run id.

import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { newRunId } from "../scripts/spike.ts";
import { redactPath } from "../src/http/redact.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { openDb } from "../src/store/db.ts";
import { Browser, startApp } from "./helpers/server.ts";

describe("finding 8: no operator token in any log line", () => {
  it("redacts operator and checkout paths", () => {
    expect(redactPath(`/o/${"a".repeat(43)}`)).toBe("/o/{token}");
    expect(redactPath("/o/anything-else")).toBe("/o/{token}");
    expect(redactPath("/api/state")).toBe("/api/state");
  });

  it("an interrupted operator POST logs no token", async () => {
    const s = await startApp();
    try {
      const b = new Browser(s.base);
      await b.json("/api/state");
      const first = await b.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday" });
      const link = new URL(first.guide_phone[0].url as string);
      const token = link.pathname.split("/o/")[1]!;
      await new Promise<void>((resolve) => {
        const req = request({ host: "127.0.0.1", port: Number(link.port), path: link.pathname, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "1000" } });
        req.on("error", () => resolve());
        req.write("action=pri");
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 50);
      });
      for (let i = 0; i < 40 && !s.logs.some((l) => l.event === "error" || (l.event === "request" && String(l.path).startsWith("/o/"))); i++) await new Promise((r) => setTimeout(r, 25));
      expect(s.logs.some((l) => String(l.path ?? "").startsWith("/o/"))).toBe(true);
      expect(JSON.stringify(s.logs)).not.toContain(token);
    } finally {
      await s.app.close();
    }
  });
});

describe("finding 9: an external checkpoint catches a deleted tail", () => {
  it("verify against the last head fails after the last row is deleted", () => {
    const db = openDb();
    const ledger = new Ledger(db);
    ledger.append("bk_1", "a", {});
    ledger.append("bk_1", "b", {});
    const checkpoint = ledger.head();
    expect(checkpoint.count).toBe(2);
    db.prepare("DELETE FROM ledger WHERE seq = 2").run();
    expect(ledger.verify().ok).toBe(true); // what the chain alone can say
    expect(ledger.verify(checkpoint)).toMatchObject({ ok: false, reason: expect.stringMatching(/checkpoint/) });
  });

  it("the app serves the head kept outside the database", async () => {
    const s = await startApp();
    try {
      const b = new Browser(s.base);
      await b.json("/api/chat", { message: "Find me a hiking guide for Le Morne on Thursday" });
      const head = await b.json("/api/ledger/head");
      expect(head.count).toBeGreaterThan(0);
      expect(head.head).toMatch(/^[0-9a-f]{64}$/);
      expect(s.logs.some((l) => l.event === "ledger_head" && l.head === head.head)).toBe(true);
    } finally {
      await s.app.close();
    }
  });
});

describe("finding 10: spike run ids never collide", () => {
  it("is a random UUID", () => {
    const a = newRunId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newRunId()).not.toBe(a);
  });
});
