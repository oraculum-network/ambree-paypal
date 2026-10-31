// The one path redaction for every log line: operator links are bearer capabilities, so their token
// never reaches a log. Query strings are never logged at all (callers pass url.pathname).

export function redactPath(pathname: string): string {
  if (pathname.startsWith("/o/")) return "/o/{token}";
  if (pathname.length > 200) return `${pathname.slice(0, 200)}…`;
  return pathname;
}
