// The guide's page is POST, then redirect, then GET (DESIGN.md §22). A form post applies the answer and
// answers 303 to the same page; the answer's message waits here, keyed by the link's token, until the next
// GET of that page shows it once and removes it. Neither the message nor any id goes in the URL.
// In memory: there is one replica, and a message lost on a restart only means the page shows without it.
// At most `limit` messages are kept; past that the oldest goes first. Keys are hashes of the token, so the
// store never holds the capability itself.

import { createHash } from "node:crypto";

export interface Flash {
  ok: boolean;
  text: string;
}

export const FLASH_LIMIT = 500;

export class Flashes {
  readonly #byKey = new Map<string, Flash>();
  readonly #limit: number;

  constructor(limit = FLASH_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Flashes: limit must be a positive integer");
    this.#limit = limit;
  }

  static #key(token: string): string {
    return createHash("sha256").update(`flash:${token}`).digest("hex");
  }

  /** Keeps `flash` for the token's next GET, replacing any earlier one; drops the oldest past the limit. */
  put(token: string, flash: Flash): void {
    const key = Flashes.#key(token);
    this.#byKey.delete(key); // a new message for a token counts as the newest
    this.#byKey.set(key, { ok: flash.ok, text: flash.text });
    while (this.#byKey.size > this.#limit) this.#byKey.delete(this.#byKey.keys().next().value!);
  }

  /** The token's waiting message, removed as it is read: it is shown once. */
  take(token: string): Flash | undefined {
    const key = Flashes.#key(token);
    const flash = this.#byKey.get(key);
    this.#byKey.delete(key);
    return flash;
  }

  get size(): number {
    return this.#byKey.size;
  }
}
