// The scripted model: deterministic tool calls for tests and the offline demo (no LLM key). It reads the
// conversation the same way a real model would (the last user message, [event] notes, tool results) and
// picks the next tool by simple rules. It is labelled "scripted model" on the page.

import type { ChatMessage, ChatModel, ModelReply, ToolCall } from "./model.ts";

const AREAS = ["Le Morne", "Black River Gorges", "Chamarel", "Tamarin", "La Gaulette"];
const ACTIVITIES = ["hike", "kayak", "snorkel", "canyoning", "birdwatching"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** What a traveller asked for, from plain text. */
export function parseRequest(text: string, today: string): { area?: string; activity?: string; date: string; party_size: number } {
  const t = text.toLowerCase();
  const area = AREAS.find((a) => t.includes(a.toLowerCase()));
  const activity = ACTIVITIES.find((a) => t.includes(a)) ?? (/\b(walk|trek|climb|hiking)\b/.test(t) ? "hike" : undefined);
  let date = addDays(today, 2);
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const dayIdx = DAYS.findIndex((d) => t.includes(d));
  if (iso) date = iso[1]!;
  else if (t.includes("tomorrow")) date = addDays(today, 1);
  else if (dayIdx >= 0) {
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    date = addDays(today, ((dayIdx - cur + 7) % 7) || 7);
  }
  let party = 2;
  const n = t.match(/\b(?:for|party of|group of)\s+(\d{1,2}|one|two|three|four|five|six)\b/) ?? t.match(/\b(\d{1,2}|one|two|three|four|five|six)\s+(?:of us|people|adults|pax)\b/);
  if (n) party = Number(n[1]) || WORD_NUMBERS[n[1]!] || 2;
  if (/\b(just me|alone|solo)\b/.test(t)) party = 1;
  return { area, activity, date, party_size: Math.min(12, Math.max(1, party)) };
}

let seq = 0;
function call(name: string, args: Record<string, unknown>): ModelReply {
  const c: ToolCall = { id: `call_s${++seq}`, name, arguments: JSON.stringify(args) };
  return { content: null, tool_calls: [c] };
}
function say(text: string): ModelReply {
  return { content: text, tool_calls: [] };
}

function lastBookingId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const text = m.role === "assistant" ? (m.tool_calls?.map((c) => c.arguments).join(" ") ?? "") : (m.content ?? "");
    const hit = text.match(/bk_[0-9a-f]{12}/g);
    if (hit) return hit.at(-1);
  }
  return undefined;
}

function lastTraveller(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && !m.content.startsWith("[event]")) return m.content;
  }
  return "";
}

export class ScriptedModel implements ChatModel {
  readonly label = "scripted model (offline demo)";
  readonly #today: () => string;

  constructor(today: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.#today = today;
  }

  async complete(messages: ChatMessage[]): Promise<ModelReply> {
    const last = messages.at(-1);
    if (!last) return say("Hello.");
    if (last.role === "tool") return this.#afterTool(last, messages);
    if (last.role !== "user") return say("…");
    const text = last.content;
    const bk = lastBookingId(messages);

    if (text.startsWith("[event]")) {
      const type = text.match(/^\[event\] (\w+)/)?.[1];
      const id = text.match(/bk_[0-9a-f]{12}/)?.[0] ?? bk;
      const detail = text.replace(/^\[event\] \w+ bk_[0-9a-f]{12}: /, "");
      switch (type) {
        case "guide_priced":
          return call("propose_mandate", { booking_id: id });
        case "mandate_approved":
          return call("create_order", { booking_id: id });
        case "paid":
          return say(`${detail} I'll keep an eye on the weather for you.`);
        case "cyclone":
          return call("check_weather", { booking_id: id });
        case "reschedule_answered":
          return /can't do/.test(detail) ? call("refund_payment", { booking_id: id }) : say(detail);
        case "refund_offered":
          return call("refund_payment", { booking_id: id });
        case "guide_declined":
          return say(`${detail} Shall I ask another guide?`);
        default:
          return say(detail);
      }
    }

    const t = text.toLowerCase();
    if (bk && /\brefund\b/.test(t)) return call("refund_payment", { booking_id: bk });
    if (bk && /\b(weather|cyclone|storm)\b/.test(t)) return call("check_weather", { booking_id: bk });
    if (bk && /\b(status|update|news)\b/.test(t)) return call("get_booking", { booking_id: bk });
    const req = parseRequest(text, this.#today());
    if (/\bguide\b/.test(t) || req.activity) return call("search_guides", { ...(req.area ? { area: req.area } : {}), ...(req.activity ? { activity: req.activity } : {}) });
    return say("I can find and book a local guide in Mauritius, for example: \"Find me a hiking guide for Le Morne on Thursday and hold the spot.\"");
  }

  #afterTool(last: Extract<ChatMessage, { role: "tool" }>, messages: ChatMessage[]): ModelReply {
    let r: Record<string, any>;
    try {
      r = JSON.parse(last.content);
    } catch {
      r = {};
    }
    if (r.error) return say(`That didn't work: ${r.error}`);
    switch (last.name) {
      case "search_guides": {
        const guides = (r.guides ?? []) as Array<{ guide_id: string; name: string; typical_price_per_person: string }>;
        if (!guides.length) return say("I found no guide for that; try another area or activity.");
        const req = parseRequest(lastTraveller(messages), this.#today());
        return call("request_quote", { guide_id: guides[0]!.guide_id, date: req.date, party_size: req.party_size, activity: req.activity ?? "hike" });
      }
      case "request_quote":
        return say(`I found ${r.guide} and asked them for a price for ${r.date} (booking ${r.booking_id}). Nothing is paid yet; I'll tell you when they reply.`);
      case "propose_mandate":
        return say(`The guide's price is in. Please approve the deposit of ${r.amount.currency_code} ${r.amount.value} to ${r.payee} with the code I sent to your inbox (it expires at ${String(r.expires_at).slice(11, 16)} UTC). Until you do, I can't create any payment.`);
      case "create_order":
        return say(`Your PayPal order is ready: ${r.amount.currency_code} ${r.amount.value} goes straight to ${r.payee}'s own PayPal account; Ambree never holds it. Press "Pay the guide in PayPal" to approve it.`);
      case "capture_order":
        return say(r.captured ? "The payment is captured." : `Waiting for your approval in PayPal (order ${r.order_status}).`);
      case "get_order":
        return say(`The PayPal order is ${r.status}.`);
      case "get_booking":
        return say(`Booking ${r.booking_id} is ${r.status}.`);
      case "check_weather": {
        const alerts = (r.alerts ?? []) as unknown[];
        if (!alerts.length) return say(String(r.explanation));
        const b = lastBookingId(messages)!;
        const date = this.#bookingDate(messages);
        return call("propose_reschedule", { booking_id: b, new_date: addDays(date ?? this.#today(), 3) });
      }
      case "propose_reschedule":
        return say(`A cyclone warning covers the day, so trails won't be safe. I've asked the guide to move the trip to ${r.reschedule?.new_date}; if they can't, I'll refund your deposit.`);
      case "refund_payment":
        return say(`Done: ${r.refunded?.currency_code} ${r.refunded?.value} refunded to you from the guide's PayPal (booking ${r.status}).`);
      default:
        return say("Done.");
    }
  }

  #bookingDate(messages: ChatMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "tool" && (m.name === "request_quote" || m.name === "get_booking")) {
        const d = (JSON.parse(m.content) as { date?: string }).date;
        if (d) return d;
      }
    }
    return undefined;
  }
}
