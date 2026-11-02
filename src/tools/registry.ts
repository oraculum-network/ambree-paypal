// The agent's tools: one registry, served to the chat model (OpenAI tool format) and over MCP.
// Each tool is a thin call into BookingService, which holds the rules. There is deliberately no tool
// that approves a mandate: only the traveller can, on the page, with the step-up code.

import { z } from "zod";
import type { Channels } from "../booking/channels.ts";
import { type BookingService, ServiceError } from "../booking/service.ts";
import { searchGuides } from "../guides/seed.ts";
import { PayPalError } from "../paypal/errors.ts";
import { firstCapture } from "../paypal/types.ts";

export interface ToolContext {
  service: BookingService;
  channels: Channels;
  conversationId: string;
  /** Where operator links go (the guide's phone panel in the demo). */
  sendOperatorLink: (conversationId: string, link: { booking_id: string; guide_name: string; url: string }) => void;
}

export type ToolOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  moneyMoving: boolean;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

const bookingId = z.string().regex(/^bk_[0-9a-f]{12}$/).describe("The booking id from request_quote, e.g. bk_0123456789ab");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

function define<S extends z.ZodObject>(t: Tool<S>): Tool<S> {
  return t;
}

/** Every booking tool starts here: a booking from another conversation is "not found". */
function own(ctx: ToolContext, bookingId: string) {
  return ctx.service.owned(bookingId, ctx.conversationId);
}

export const TOOLS = [
  define({
    name: "search_guides",
    title: "Search guides",
    description: "Find independent local guides in Mauritius by area (e.g. Le Morne), activity (hike, kayak…) and language. Returns ids, names, languages and a typical price per person.",
    input: z.object({ area: z.string().max(60).optional(), activity: z.string().max(40).optional(), language: z.string().max(10).optional() }),
    moneyMoving: false,
    run: async (a, ctx) => {
      const found = searchGuides(ctx.service.guides, a).map((g) => ({ guide_id: g.id, name: g.name, areas: g.areas, activities: g.activities, languages: g.languages, bio: g.bio, typical_price_per_person: `${g.currency} ${g.typical_price_per_person}` }));
      return { guides: found, count: found.length };
    },
  }),
  define({
    name: "request_quote",
    title: "Ask a guide for a price",
    description: "Send a booking request to one guide. The guide gets a private link and replies with a total and a deposit; you will get an [event] when they do. Nothing is paid.",
    input: z.object({ guide_id: z.string().max(40), date: isoDate, party_size: z.number().int().min(1).max(12), activity: z.string().max(40), note: z.string().max(500).optional() }),
    moneyMoving: false,
    run: async (a, ctx) => {
      const { booking, operatorUrl } = ctx.service.requestQuote({ conversation_id: ctx.conversationId, ...a });
      ctx.sendOperatorLink(ctx.conversationId, { booking_id: booking.id, guide_name: booking.guide_name, url: operatorUrl });
      return { booking_id: booking.id, status: booking.status, guide: booking.guide_name, date: booking.date, sent: "The guide was sent a private link to price the request." };
    },
  }),
  define({
    name: "get_booking",
    title: "Get a booking",
    description: "The booking's status, the guide's quote, the mandate, the PayPal order, the capture and any refund or reschedule.",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: false,
    run: async (a, ctx) => ctx.service.summary(own(ctx, a.booking_id)),
  }),
  define({
    name: "propose_mandate",
    title: "Ask the traveller to approve the deposit",
    description:
      "Once the guide has priced, build the payment mandate (amount = deposit, payee = the guide's own PayPal, quote hash, 15-minute expiry, single-use nonce). The traveller gets a step-up code privately and approves on the page; you will get an [event]. You never see the code.",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: false,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const m = await ctx.service.proposeMandate(a.booking_id);
      return { mandate_id: m.id, status: m.status, amount: m.amount, payee: m.payee_name, quote_hash: m.quote_hash, expires_at: m.expires_at, next: "Wait for the traveller to approve with their code." };
    },
  }),
  define({
    name: "create_order",
    title: "Create the PayPal order",
    description: "Create the PayPal order for the deposit, payee = the guide's own PayPal account. Works only inside an approved, unexpired, unused mandate whose amount, payee and quote hash still match. Returns the link where the traveller pays.",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: true,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const b = await ctx.service.createOrder(a.booking_id);
      return { booking_id: b.id, order_id: b.order_id, approve_url: b.approve_url, amount: b.quote?.deposit, payee: b.guide_name, status: b.status };
    },
  }),
  define({
    name: "get_order",
    title: "Get the PayPal order",
    description: "The PayPal order's current status (PAYER_ACTION_REQUIRED, APPROVED, COMPLETED…).",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: false,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const o = await ctx.service.getOrder(a.booking_id);
      return { order_id: o.id, status: o.status, payee: o.purchase_units?.[0]?.payee ?? null, capture: firstCapture(o) ? { id: firstCapture(o)!.id, status: firstCapture(o)!.status } : null };
    },
  }),
  define({
    name: "capture_order",
    title: "Capture the payment",
    description: "Capture the deposit once the traveller approved it in PayPal (normally automatic on return). Idempotent.",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: true,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const r = await ctx.service.captureIfApproved(a.booking_id);
      return { captured: r.captured, order_status: r.order_status, capture_status: r.capture_status ?? null, status: r.booking.status, capture_id: r.booking.capture_id ?? null };
    },
  }),
  define({
    name: "check_weather",
    title: "Check cyclone warnings",
    description: "Cyclone warnings covering the booking's date, with a plain explanation of the risk.",
    input: z.object({ booking_id: bookingId }),
    moneyMoving: false,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const w = await ctx.service.weatherFor(a.booking_id);
      return { alerts: w.alerts.map((x) => ({ name: x.name, level: x.level, from: x.from, to: x.to, source: x.source })), explanation: w.explanation, refund_allowed: Boolean(await ctx.service.refundReason(ctx.service.must(a.booking_id))) };
    },
  }),
  define({
    name: "propose_reschedule",
    title: "Ask the guide to move the trip",
    description: "Ask the guide (on their page) to move a paid booking to new_date. You will get an [event] with their answer.",
    input: z.object({ booking_id: bookingId, new_date: isoDate }),
    moneyMoving: false,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const b = await ctx.service.proposeReschedule(a.booking_id, a.new_date);
      return { booking_id: b.id, reschedule: b.reschedule, sent: "The guide was asked on their page." };
    },
  }),
  define({
    name: "refund_payment",
    title: "Refund the deposit",
    description: "Refund the deposit (all of it, or `amount`) from the guide's capture back to the traveller. Allowed only when a cyclone warning (orange/red) covers the date, the guide declined a reschedule, or the guide offered a refund. A simulated (demo) warning alone does not allow it.",
    input: z.object({ booking_id: bookingId, amount: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/).optional() }),
    moneyMoving: true,
    run: async (a, ctx) => {
      own(ctx, a.booking_id);
      const b = await ctx.service.refund(a.booking_id, a.amount);
      const s = ctx.service.summary(b);
      return { booking_id: b.id, status: b.status, refunded: s.refunded, refund_pending: s.refund_pending, refund_ids: b.refund_ids };
    },
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
export const TOOL_NAMES = TOOLS.map((t) => t.name) as ToolName[];

export function findTool(name: string): Tool | undefined {
  return (TOOLS as readonly Tool[]).find((t) => t.name === name);
}

/** Validates and runs a tool; every failure becomes a message the model can read (never a stack or secret). */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = findTool(name);
  if (!tool) return { ok: false, message: `Unknown tool ${String(name).slice(0, 40)}.` };
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, message: `Invalid arguments for ${name}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` };
  try {
    return { ok: true, value: await tool.run(parsed.data as never, ctx) };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, message: `${e.code}: ${e.message}` };
    if (e instanceof PayPalError) return { ok: false, message: `PayPal error: ${e.summary()}` };
    return { ok: false, message: "The tool failed unexpectedly." };
  }
}

/** The tools in OpenAI chat-completions format. */
export function openAiTools(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return (TOOLS as readonly Tool[]).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown> } }));
}
