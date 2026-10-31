// Sandbox only. The one base URL this code will ever call; anything else is refused before a request is built.

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

export class LiveEnvironmentRefused extends Error {
  override name = "LiveEnvironmentRefused";
}

/**
 * Returns the sandbox base if `url` is it (trailing slash allowed), else throws.
 * The message names the host only, never a path or query.
 */
export function assertSandboxBase(url: string | undefined): string {
  if (url === undefined || url === "") return SANDBOX_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LiveEnvironmentRefused("PAYPAL_BASE_URL is not a URL; only the PayPal sandbox is allowed");
  }
  const clean = parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
  if (parsed.origin !== SANDBOX_API_BASE || !clean) {
    throw new LiveEnvironmentRefused(`Refusing PayPal base ${parsed.host || "(none)"}: only ${SANDBOX_API_BASE} is allowed (sandbox only)`);
  }
  return SANDBOX_API_BASE;
}
