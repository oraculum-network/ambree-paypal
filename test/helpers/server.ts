// Starts the real HTTP app on a free port with captured logs, and a tiny cookie-keeping client.

import { type App, createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";

export async function startApp(env: Record<string, string> = {}) {
  const probe = createApp({ config: loadConfig({ PORT: "0", HOST: "127.0.0.1" }) });
  const port = await probe.listen();
  await probe.close();
  const logs: Array<Record<string, unknown>> = [];
  const app: App = createApp({
    config: loadConfig({ PORT: String(port), HOST: "127.0.0.1", PUBLIC_URL: `http://127.0.0.1:${port}`, ...env }),
    today: () => "2026-11-03",
    logger: (f) => void logs.push(f),
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

  async json(path: string, body?: unknown): Promise<Record<string, any>> {
    const res = await this.fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, any>;
  }
}
