// Judge polish (4 Nov): a local run opened on localhost. With no PUBLIC_URL the public URL is
// http://127.0.0.1:<PORT>, and the Origin check refuses a POST from any other origin, so a page opened at
// http://localhost:<PORT> stayed at "loading…" (and the fake checkout and PayPal's return URL use 127.0.0.1,
// so a cookie set on localhost would be lost on the way back anyway). Now, only when PUBLIC_URL is not set, a
// GET or HEAD for Host localhost:<PORT> is sent to the same path and query on http://127.0.0.1:<PORT> (307).
// Nothing else changes: no second origin is accepted, and with PUBLIC_URL set (the hosted site) every reply is
// as before.

import { type IncomingHttpHeaders, request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { startApp } from "./helpers/server.ts";

type Started = Awaited<ReturnType<typeof startApp>>;
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One request to the app on 127.0.0.1 with the Host header a browser would send for `host`. */
function raw(s: Started, method: string, path: string, host: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  const port = Number(new URL(s.base).port);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, Host: host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const portOf = (s: Started) => Number(new URL(s.base).port);
const TOKEN_PATH = `/o/${"A".repeat(43)}`;

describe("config: whether PUBLIC_URL was set", () => {
  it("unset: the public URL is http://127.0.0.1:<PORT>, marked as the default", () => {
    const c = loadConfig({ PORT: "8080" });
    expect(c.publicUrl).toBe("http://127.0.0.1:8080");
    expect(c.publicUrlSet).toBe(false);
  });
  it("set: as given", () => {
    const c = loadConfig({ PORT: "8080", PUBLIC_URL: "https://paypal.ambree.ai/" });
    expect(c.publicUrl).toBe("https://paypal.ambree.ai");
    expect(c.publicUrlSet).toBe(true);
  });
});

describe("no PUBLIC_URL (a local run): localhost:<PORT> is sent to 127.0.0.1:<PORT>", () => {
  let s: Started;
  beforeAll(async () => {
    s = await startApp({ PUBLIC_URL: undefined });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("a GET of the page is a 307 to the same path on 127.0.0.1, and sets no cookie on localhost", async () => {
    const port = portOf(s);
    const r = await raw(s, "GET", "/", `localhost:${port}`);
    expect(r.status).toBe(307);
    expect(r.headers.location).toBe(`http://127.0.0.1:${port}/`);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.body).toBe("");
    // Followed, it is the page, which sets the session cookie on 127.0.0.1.
    const page = await raw(s, "GET", "/", `127.0.0.1:${port}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("Guide's phone");
    expect(page.headers["set-cookie"]?.[0]).toMatch(/^amb_sid=/);
  });

  it("the path and query are kept, and the host matches in any case", async () => {
    const port = portOf(s);
    for (const [method, host, path] of [
      ["GET", `LocalHost:${port}`, `${TOKEN_PATH}?a=1&b=%20c`],
      ["GET", `LOCALHOST:${port}`, "/api/state?conversation_id=cv_000000000000000000000000"],
      ["HEAD", `localhost:${port}`, "/healthz"],
      ["GET", `localhost:${port}`, "/paypal/return?booking=bk_000000000000&token=ABC"],
    ] as const) {
      const r = await raw(s, method, path, host);
      expect(r.status, `${method} ${host} ${path}`).toBe(307);
      expect(r.headers.location, path).toBe(`http://127.0.0.1:${port}${path}`);
    }
  });

  it("kept: a POST on localhost is not redirected, and localhost is no second accepted origin", async () => {
    const port = portOf(s);
    const json = { "Content-Type": "application/json" };
    const cross = await raw(s, "POST", "/api/conversations", `localhost:${port}`, { ...json, Origin: `http://localhost:${port}` }, "{}");
    expect(cross.status).toBe(403);
    expect(cross.headers.location).toBeUndefined();
    expect(cross.headers["set-cookie"]).toBeUndefined();
    const form = await raw(s, "POST", TOKEN_PATH, `localhost:${port}`, { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://localhost:${port}` }, "action=decline");
    expect(form.status).toBe(403);
    // 127.0.0.1 is still the one origin accepted.
    expect((await raw(s, "POST", "/api/conversations", `127.0.0.1:${port}`, { ...json, Origin: `http://127.0.0.1:${port}` }, "{}")).status).toBe(200);
  });

  it("kept: any other Host is served as before", async () => {
    const port = portOf(s);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port + 1}`, "localhost", `app.localhost:${port}`, `localhost.example:${port}`]) {
      const r = await raw(s, "GET", "/healthz", host);
      expect(r.status, host).toBe(200);
      expect(r.headers.location, host).toBeUndefined();
    }
  });
});

/** Every header but the ones that differ between any two requests (the date, a fresh session cookie). */
function stable(r: Reply) {
  const { date: _d, "set-cookie": cookie, ...rest } = r.headers;
  return { status: r.status, headers: rest, cookieName: cookie?.map((c) => c.split("=")[0]), body: r.body };
}

describe.each([
  // startApp's default: PUBLIC_URL=http://127.0.0.1:<PORT>, set, so nothing is redirected.
  ["the helper's own, http://127.0.0.1:<PORT>", {}, (port: number) => `127.0.0.1:${port}`],
  ["the hosted site's, https://paypal.ambree.ai", { PUBLIC_URL: "https://paypal.ambree.ai" }, () => "paypal.ambree.ai"],
])("PUBLIC_URL set (%s): Host localhost:<PORT> is answered exactly as before", (_label, env, ownHost) => {
  let s: Started;
  beforeAll(async () => {
    s = await startApp(env);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it("no redirect, and the same status, headers and body as for the site's own Host", async () => {
    const port = portOf(s);
    for (const [method, path] of [
      ["GET", "/"],
      ["HEAD", "/"],
      ["GET", "/healthz"],
      ["GET", `${TOKEN_PATH}?a=1`],
      ["GET", "/api/state?conversation_id=cv_000000000000000000000000"],
      ["GET", "/nope"],
    ] as const) {
      const local = await raw(s, method, path, `localhost:${port}`);
      expect(local.status, `${method} ${path}`).not.toBe(307);
      expect(local.headers.location, path).toBeUndefined();
      expect(stable(local), `${method} ${path}`).toEqual(stable(await raw(s, method, path, ownHost(port))));
    }
  });
});
