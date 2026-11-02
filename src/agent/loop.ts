// The tool loop: one traveller message (or a batch of [event] notes) → model → tools → … → a reply.
// Conversations live in memory (the demo); the ledger and bookings live in sqlite.

import { type ToolContext, TOOL_NAMES, openAiTools, runTool } from "../tools/registry.ts";
import type { ChatMessage, ChatModel } from "./model.ts";
import { ModelError } from "./model.ts";

export const MAX_STEPS = 8;
const MAX_MESSAGES = 120;

export function systemPrompt(today: string): string {
  return [
    "You are Ambree, a travel concierge in Mauritius. You find small independent local guides and book them for the traveller.",
    `Today is ${today}. Dates are YYYY-MM-DD.`,
    "Flow: search_guides → request_quote (the guide prices on their own page) → when an [event] says the guide priced, propose_mandate → when an [event] says the traveller approved, create_order and give them the pay link.",
    "Money rules: payments go from the traveller straight to the guide's own PayPal account; Ambree never holds money. You cannot approve a mandate: only the traveller can, with a code you never see. Never ask for the code.",
    "If a cyclone [event] arrives: check_weather, explain the risk in one sentence, propose_reschedule a few days later; if the guide declines or offers a refund, refund_payment.",
    "A warning whose source is \"simulated\" comes from the page's demo control, not a weather service: say it is simulated, and still check_weather and propose_reschedule as for a real one. It does not allow a refund by itself: refund_payment only once the guide declines the new date or offers a refund.",
    "A booking's reschedule status is proposed (asked; the guide can answer it only while the booking is captured and no refund has started: when get_booking's reschedule_hold is set, the move waits on that, not on the guide, so say so), accepted (the date moved), declined (a refund is now allowed) or withdrawn: a refund of the deposit (part or all of it) completed before the guide answered, so the guide is no longer asked and the date stays. Don't propose another move once a refund has started; propose_reschedule refuses it.",
    "If refund_payment answers date_changed, the booking's date changed while the weather was checked and nothing was refunded: call refund_payment once again; if it is refused again, explain and stop.",
    "Messages that start with [event] are system notifications, not the traveller. Keep replies to 2-3 short sentences. Say it is a sandbox demo if asked about real money.",
    `Your tools: ${TOOL_NAMES.join(", ")}.`,
  ].join("\n");
}

export interface TurnResult {
  reply: string;
  tools: Array<{ name: string; ok: boolean }>;
}

export class Agent {
  readonly #model: ChatModel;
  readonly #ctx: Omit<ToolContext, "conversationId">;
  readonly #today: () => string;
  readonly #conversations = new Map<string, ChatMessage[]>();
  readonly #busy = new Map<string, Promise<unknown>>();

  constructor(model: ChatModel, ctx: Omit<ToolContext, "conversationId">, today: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.#model = model;
    this.#ctx = ctx;
    this.#today = today;
  }

  get modelLabel(): string {
    return this.#model.label;
  }

  /** The visible transcript: traveller, events and Ambree's replies (no tool payloads). */
  transcript(conversationId: string): Array<{ role: "traveller" | "event" | "ambree"; text: string }> {
    type Line = { role: "traveller" | "event" | "ambree"; text: string };
    return (this.#conversations.get(conversationId) ?? []).flatMap((m): Line[] => {
      if (m.role === "user") return [{ role: m.content.startsWith("[event]") ? ("event" as const) : ("traveller" as const), text: m.content }];
      if (m.role === "assistant" && m.content) return [{ role: "ambree" as const, text: m.content }];
      return [];
    });
  }

  /** One turn per conversation at a time. */
  async turn(conversationId: string, userText: string): Promise<TurnResult> {
    const prior = this.#busy.get(conversationId) ?? Promise.resolve();
    const run = prior.then(() => this.#turn(conversationId, userText));
    this.#busy.set(conversationId, run.catch(() => undefined));
    return run;
  }

  async #turn(conversationId: string, userText: string): Promise<TurnResult> {
    const messages = this.#conversations.get(conversationId) ?? [{ role: "system", content: systemPrompt(this.#today()) }];
    this.#conversations.set(conversationId, messages);
    messages.push({ role: "user", content: userText.slice(0, 2000) });
    const ctx: ToolContext = { ...this.#ctx, conversationId };
    const tools: TurnResult["tools"] = [];
    const specs = openAiTools();
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await this.#model.complete(messages, specs);
        if (!reply.tool_calls.length) {
          const text = reply.content?.trim() || "…";
          messages.push({ role: "assistant", content: text });
          return { reply: text, tools };
        }
        messages.push({ role: "assistant", content: reply.content, tool_calls: reply.tool_calls });
        for (const c of reply.tool_calls) {
          let args: unknown;
          try {
            args = JSON.parse(c.arguments || "{}");
          } catch {
            args = undefined;
          }
          const out = args === undefined ? { ok: false as const, message: "Arguments were not JSON." } : await runTool(c.name, args, ctx);
          tools.push({ name: c.name, ok: out.ok });
          messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: JSON.stringify(out.ok ? out.value : { error: out.message }) });
        }
      }
      const text = "I stopped after too many steps; please tell me what you'd like next.";
      messages.push({ role: "assistant", content: text });
      return { reply: text, tools };
    } catch (e) {
      const text = e instanceof ModelError ? `Sorry, my model is unavailable (${e.message}). Bookings and payments are unaffected.` : "Sorry, something went wrong.";
      messages.push({ role: "assistant", content: text });
      return { reply: text, tools };
    } finally {
      if (messages.length > MAX_MESSAGES) messages.splice(1, messages.length - MAX_MESSAGES);
    }
  }
}
