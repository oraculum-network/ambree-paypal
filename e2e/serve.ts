// The e2e server: fake PayPal, scripted model, in-memory sqlite, fixed "today" so dates are stable.

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const PORT = 3891;
const app = createApp({ config: loadConfig({ PORT: String(PORT), HOST: "127.0.0.1", PUBLIC_URL: `http://127.0.0.1:${PORT}` }), today: () => "2026-11-03" });
await app.listen();
process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));
