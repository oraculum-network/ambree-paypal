// Amounts: decimal strings on the wire, integer minor units inside. EUR and USD both have 2 decimals.

import type { CurrencyCode, Money } from "./types.ts";

export const CURRENCIES: readonly CurrencyCode[] = ["EUR", "USD"];
const VALUE_RE = /^(0|[1-9]\d{0,6})(\.\d{1,2})?$/;

export function isCurrency(c: unknown): c is CurrencyCode {
  return typeof c === "string" && (CURRENCIES as readonly string[]).includes(c);
}

/** "30.5" → 3050. Throws on anything that is not a plain non-negative amount with at most 2 decimals. */
export function toMinor(value: string): number {
  if (!VALUE_RE.test(value)) throw new RangeError(`Not an amount: ${JSON.stringify(value.slice(0, 20))}`);
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 3050 → "30.50". */
export function fromMinor(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`Not a minor amount: ${minor}`);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

export function money(currency_code: CurrencyCode, minor: number): Money {
  return { currency_code, value: fromMinor(minor) };
}

export function sameMoney(a: Money, b: Money): boolean {
  return a.currency_code === b.currency_code && toMinor(a.value) === toMinor(b.value);
}

export function formatMoney(m: Money): string {
  return `${m.currency_code} ${fromMinor(toMinor(m.value))}`;
}
