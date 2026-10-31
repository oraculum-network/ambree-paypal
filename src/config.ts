// Configuration from the environment, by name. Errors name variables, never values.
// PayPal: sandbox mode when PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are both set, else the in-process fake.
// The model: OpenAI-compatible when LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are all set, else scripted.

import { isOperator } from "./mandate/mandate.ts";
import { assertSandboxBase } from "./paypal/sandbox.ts";
import type { Payee } from "./paypal/types.ts";

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dbPath: string;
  paypal: { mode: "fake" } | { mode: "sandbox"; clientId: string; clientSecret: string; webhookId?: string; baseUrl: string };
  llm: { mode: "scripted" } | { mode: "openai"; baseUrl: string; apiKey: string; model: string };
  /** One sandbox business account that plays every guide (hosted demo). */
  guidePayee?: Payee;
  /** The REST app owner's own account(s): never a payee. From PAYPAL_OPERATOR_EMAIL / PAYPAL_OPERATOR_MERCHANT_ID. */
  operatorPayees: Payee[];
  /** MCP is off unless MCP_DEMO_PASSCODE is set; callers send it as a Bearer token. */
  mcpPasscode?: string;
}

/** The fake PayPal's stand-in for the app owner, used when no operator identity is configured. */
export const FAKE_OPERATOR: Payee = { email_address: "ambree-operator@business.sandbox.example" };

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
  const paypal: Config["paypal"] = id && secret ? { mode: "sandbox", clientId: id, clientSecret: secret, webhookId: env.PAYPAL_WEBHOOK_ID || undefined, baseUrl } : { mode: "fake" };

  const llmSet = [env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL].filter(Boolean).length;
  if (llmSet !== 0 && llmSet !== 3) throw new ConfigError("Set all of LLM_BASE_URL, LLM_API_KEY and LLM_MODEL, or none (scripted model)");
  const llm: Config["llm"] = llmSet === 3 ? { mode: "openai", baseUrl: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, model: env.LLM_MODEL! } : { mode: "scripted" };

  let guidePayee: Payee | undefined;
  if (env.PAYPAL_GUIDE_PAYEE_EMAIL && env.PAYPAL_GUIDE_PAYEE_MERCHANT_ID) throw new ConfigError("Set PAYPAL_GUIDE_PAYEE_EMAIL or PAYPAL_GUIDE_PAYEE_MERCHANT_ID, not both");
  if (env.PAYPAL_GUIDE_PAYEE_EMAIL) guidePayee = { email_address: env.PAYPAL_GUIDE_PAYEE_EMAIL };
  if (env.PAYPAL_GUIDE_PAYEE_MERCHANT_ID) guidePayee = { merchant_id: env.PAYPAL_GUIDE_PAYEE_MERCHANT_ID };
  if (paypal.mode === "sandbox" && !guidePayee) throw new ConfigError("Sandbox mode needs PAYPAL_GUIDE_PAYEE_EMAIL or PAYPAL_GUIDE_PAYEE_MERCHANT_ID (the guide's sandbox business account)");

  const operatorPayees: Payee[] = [];
  if (env.PAYPAL_OPERATOR_EMAIL) operatorPayees.push({ email_address: env.PAYPAL_OPERATOR_EMAIL });
  if (env.PAYPAL_OPERATOR_MERCHANT_ID) operatorPayees.push({ merchant_id: env.PAYPAL_OPERATOR_MERCHANT_ID });
  if (paypal.mode === "sandbox" && !operatorPayees.length) {
    throw new ConfigError("Sandbox mode needs PAYPAL_OPERATOR_EMAIL and/or PAYPAL_OPERATOR_MERCHANT_ID (the REST app owner's account, which must never be a payee)");
  }
  if (!operatorPayees.length) operatorPayees.push(FAKE_OPERATOR);
  if (guidePayee && isOperator(guidePayee, operatorPayees)) throw new ConfigError("The guide payee is the operator's own account; Ambree must never be the payee");

  return { port, host, publicUrl, dbPath: env.DB_PATH ?? ":memory:", paypal, llm, guidePayee, operatorPayees, mcpPasscode: env.MCP_DEMO_PASSCODE || undefined };
}
