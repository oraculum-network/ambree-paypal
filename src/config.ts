// Configuration from the environment, by name. Errors name variables, never values.
// PayPal: sandbox mode when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are both set (and then the guide's own
// app, PAYPAL_GUIDE_CLIENT_ID and PAYPAL_GUIDE_CLIENT_SECRET, too), else the in-process fake.
// The model: OpenAI-compatible when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all set, else scripted.

import type { MerchantPayee } from "./guides/seed.ts";
import { isOperator } from "./mandate/mandate.ts";
import { assertSandboxBase } from "./paypal/sandbox.ts";
import type { Payee } from "./paypal/types.ts";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  /**
   * Whether PUBLIC_URL was set. Unset (a local run), the public URL is http://127.0.0.1:<PORT>, and a GET or
   * HEAD for Host localhost:<PORT> is redirected there (DESIGN.md §22); set (the hosted site), never.
   */
  publicUrlSet: boolean;
  dbPath: string;
  /**
   * Sandbox: two REST apps (DESIGN.md §21, D1). The operator's (PAYPAL_CLIENT_ID/SECRET, webhook
   * PAYPAL_WEBHOOK_ID) makes and captures orders; the guide's own (PAYPAL_GUIDE_CLIENT_ID/SECRET, webhook
   * PAYPAL_GUIDE_WEBHOOK_ID) refunds the captures paid to PAYPAL_GUIDE_PAYEE_MERCHANT_ID. Either webhook id
   * may be empty: its endpoint then answers 503.
   */
  paypal:
    | { mode: "fake" }
    | { mode: "sandbox"; clientId: string; clientSecret: string; webhookId?: string; guideClientId: string; guideClientSecret: string; guideWebhookId?: string; baseUrl: string };
  llm: { mode: "scripted" } | { mode: "openai"; baseUrl: string; apiKey: string; model: string };
  /** One sandbox business account that plays every guide (hosted demo). */
  guidePayee?: MerchantPayee;
  /** The REST app owner's own account(s): never a payee. From PAYPAL_OPERATOR_EMAIL / PAYPAL_OPERATOR_MERCHANT_ID. */
  operatorPayees: Payee[];
  /**
   * "paypal" (default): at startup, ask PayPal which merchant owns the REST app and refuse to start unless it
   * is PAYPAL_OPERATOR_MERCHANT_ID and no guide's. "config-only" (PAYPAL_OPERATOR_IDENTITY=config-only): an
   * explicit, logged opt-out while that call is unconfirmed (spike S11); /healthz then says "config-only".
   */
  operatorIdentityCheck: "paypal" | "config-only";
  /** MCP is off unless MCP_DEMO_PASSCODE is set; callers send it as a Bearer token. */
  mcpPasscode?: string;
}

/** The fake PayPal's stand-in for the app owner, used when no operator identity is configured. */
export const FAKE_OPERATOR: MerchantPayee = { merchant_id: "AMBREEOPER001" };
/** PayPal merchant ids seen are 13 capital letters and digits; the exact rule is UNVERIFIED, so 8-20 is allowed. */
export const MERCHANT_ID_RE = /^[A-Z0-9]{8,20}$/;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PORT must be a port number");
  const host = env.HOST ?? "0.0.0.0";
  const publicUrl = (env.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  try {
    new URL(publicUrl);
  } catch {
    throw new ConfigError("PUBLIC_URL must be a URL");
  }

  // Refuse live before anything else, whether or not credentials are set.
  const baseUrl = assertSandboxBase(env.PAYPAL_BASE_URL);
  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (Boolean(id) !== Boolean(secret)) throw new ConfigError("Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, or neither (fake PayPal)");
  const sandbox = Boolean(id && secret);
  const guideId = env.PAYPAL_GUIDE_CLIENT_ID;
  const guideSecret = env.PAYPAL_GUIDE_CLIENT_SECRET;
  if (!sandbox && (guideId || guideSecret)) {
    throw new ConfigError("PAYPAL_GUIDE_CLIENT_ID and PAYPAL_GUIDE_CLIENT_SECRET are for sandbox mode: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET too, or none of them (fake PayPal)");
  }

  const llmSet = [env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL].filter(Boolean).length;
  if (llmSet !== 0 && llmSet !== 3) throw new ConfigError("Set all of LLM_BASE_URL, LLM_API_KEY and LLM_MODEL, or none (scripted model)");
  const llm: Config["llm"] = llmSet === 3 ? { mode: "openai", baseUrl: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL! } : { mode: "scripted" };

  // Accounts are identified by merchant id only: one PayPal account can have several email aliases, so
  // an email can't prove two payees are different accounts. Email variables are refused, not ignored.
  if (env.PAYPAL_GUIDE_PAYEE_EMAIL) throw new ConfigError("PAYPAL_GUIDE_PAYEE_EMAIL is not supported: set PAYPAL_GUIDE_PAYEE_MERCHANT_ID (emails can be aliases of the operator's account)");
  if (env.PAYPAL_OPERATOR_EMAIL) throw new ConfigError("PAYPAL_OPERATOR_EMAIL is not supported: set PAYPAL_OPERATOR_MERCHANT_ID (accounts are compared by merchant id only)");
  const merchant = (name: string): MerchantPayee | undefined => {
    const v = env[name];
    if (!v) return undefined;
    if (!MERCHANT_ID_RE.test(v)) throw new ConfigError(`${name} must be a PayPal merchant id (8-20 capital letters and digits)`);
    return { merchant_id: v };
  };
  const guidePayee = merchant("PAYPAL_GUIDE_PAYEE_MERCHANT_ID");
  if (sandbox && !guidePayee) throw new ConfigError("Sandbox mode needs PAYPAL_GUIDE_PAYEE_MERCHANT_ID (the guide's sandbox business account)");
  const operator = merchant("PAYPAL_OPERATOR_MERCHANT_ID");
  if (sandbox && !operator) {
    throw new ConfigError("Sandbox mode needs PAYPAL_OPERATOR_MERCHANT_ID (the REST app owner's account, which must never be a payee)");
  }
  const operatorPayees: Payee[] = [operator ?? FAKE_OPERATOR];
  if (guidePayee && isOperator(guidePayee, operatorPayees)) throw new ConfigError("The guide payee is the operator's own account; Ambree must never be the payee");
  // D1 (DESIGN.md §21): PayPal refuses the operator's app a refund of the guide's capture (spike, 3 Nov), so
  // sandbox mode needs the guide's own app, as it needs the operator's.
  if (sandbox && (!guideId || !guideSecret)) {
    throw new ConfigError("Sandbox mode needs PAYPAL_GUIDE_CLIENT_ID and PAYPAL_GUIDE_CLIENT_SECRET (the guide's own REST app, which makes the refunds: PayPal refuses them to the operator's app)");
  }
  if (sandbox && guideId === id) throw new ConfigError("PAYPAL_GUIDE_CLIENT_ID is PAYPAL_CLIENT_ID: the refunds need the guide's own REST app, not the operator's");
  const paypal: Config["paypal"] =
    sandbox && id && secret && guideId && guideSecret
      ? { mode: "sandbox", clientId: id, clientSecret: secret, webhookId: env.PAYPAL_WEBHOOK_ID || undefined, guideClientId: guideId, guideClientSecret: guideSecret, guideWebhookId: env.PAYPAL_GUIDE_WEBHOOK_ID || undefined, baseUrl }
      : { mode: "fake" };

  const idCheck = env.PAYPAL_OPERATOR_IDENTITY ?? "paypal";
  if (idCheck !== "paypal" && idCheck !== "config-only") throw new ConfigError("PAYPAL_OPERATOR_IDENTITY must be paypal (default) or config-only");

  return { port, host, publicUrl, publicUrlSet: env.PUBLIC_URL !== undefined, dbPath: env.DB_PATH ?? ":memory:", paypal, llm, guidePayee, operatorPayees, operatorIdentityCheck: idCheck, mcpPasscode: env.MCP_DEMO_PASSCODE || undefined };
}
