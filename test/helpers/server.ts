// Starts the real HTTP app on a free port with captured logs, and a tiny cookie-keeping client.

import { type App, type AppOptions, createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";

/**
 * `options` reach createApp as they are (e.g. `paypalFetch` for a sandbox-mode app with no network). An env
 * value of `undefined` unsets the helper's default, e.g. `{ PUBLIC_URL: undefined }` for a local run's.
 */
export async function startApp(env: Record<string, string | undefined> = {}, options: Omit<AppOptions, "config"> = {}) {
  const probe = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }) });
  const port = await probe.listen();
  await probe.close();
  const logs: Array<Record<string, unknown>> = [];
  const app: App = createApp({
    today: () => "2026-11-03",
    logger: (f) => void logs.push(f),
    ...options,
    config: loadConfig({ PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: `http://127.0.0.1:${port}`, ...env }),
  });
  await app.listen();
  return { app, base: `http://127.0.0.1:${port}`, logs };
}

/** A browser stand-in: keeps the cookies the server sets. */
export class Browser {
  cookie = "";
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    const res = await fetch(path.startsWith("http") ? path : `${this.base}${path}`, { ...init, headers, redirect: "manual" });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const pair = c.split(";")[0]!;
      const name = pair.split("=")[0]!;
      const rest = this.cookie
        .split("; ")
        .filter((p) => p && !p.startsWith(`${name}=`));
      this.cookie = [...rest, pair].join("; ");
    }
    return res;
  }

  /** This "tab's" conversation, as the page keeps it in sessionStorage. */
  conv: string | undefined;

  /**
   * JSON call like the page makes: the tab's conversation id is added to /api/* calls that don't name
   * one (a conversation is started first if the tab has none).
   */
  async json(path: string, body?: unknown): Promise<Record<string, any>> {
    let p = path;
    let b = body;
    const scoped = (path === "/api/chat" || path.startsWith("/api/state") || path === "/api/demo/cyclone") && !path.includes("conversation_id=");
    if (scoped && !(b && typeof b === "object" && "conversation_id" in b)) {
      if (!this.conv) await this.json("/api/conversations", {});
      if (b === undefined) p += `${p.includes("?") ? "&" : "?"}conversation_id=${this.conv}`;
      else b = { ...(b as object), conversation_id: this.conv };
    }
    const res = await this.fetch(p, b === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const out = (await res.json()) as Record<string, any>;
    if (path === "/api/conversations" && typeof out.conversation_id === "string") this.conv = out.conversation_id;
    return out;
  }
}
