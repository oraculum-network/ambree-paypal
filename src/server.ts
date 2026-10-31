// Entry point: node src/server.ts (Node 22.18+ runs TypeScript by stripping types).
// The one place that reads process.env. It logs the modes, never a credential.

import { type App, VERSION, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const log = (fields: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...fields })}\n`);

let app: App | undefined;
try {
  const config = loadConfig(process.env);
  app = createApp({ config, logger: log });
  const port = await app.listen();
  log({ event: "listening", port, version: VERSION, paypal: config.paypal.mode, model: config.llm.mode, public_url: config.publicUrl });
} catch (e) {
  // Config errors name variables only, so the message is safe to print.
  process.stderr.write(`ambree-paypal failed to start: ${e instanceof Error ? e.message : "unknown error"}\n`);
  process.exit(1);
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log({ event: "shutdown", signal });
  setTimeout(() => process.exit(0), 10_000).unref();
  if (!app) process.exit(0);
  void app.close().then(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
