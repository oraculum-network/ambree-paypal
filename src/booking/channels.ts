// Per-conversation notifications. `events` are what the agent may read (as "[event]" notes); the
// `inbox` is the traveller's private channel (the step-up code), which no tool and no model ever reads.

export type AppEvent =
  | { type: "guide_priced"; booking_id: string; text: string }
  | { type: "guide_declined"; booking_id: string; text: string }
  | { type: "mandate_approved"; booking_id: string; text: string }
  | { type: "paid"; booking_id: string; text: string }
  | { type: "refunded"; booking_id: string; text: string }
  | { type: "reschedule_answered"; booking_id: string; text: string }
  | { type: "refund_offered"; booking_id: string; text: string }
  | { type: "cyclone"; booking_id: string; text: string };

export interface InboxMessage {
  at: string;
  booking_id: string;
  mandate_id: string;
  text: string;
  code: string;
}

export class Channels {
  readonly #events = new Map<string, AppEvent[]>();
  readonly #inbox = new Map<string, InboxMessage[]>();

  emit(conversationId: string, e: AppEvent): void {
    const list = this.#events.get(conversationId) ?? [];
    list.push(e);
    this.#events.set(conversationId, list);
  }

  /** Takes the events not yet handed to the agent. */
  drain(conversationId: string): AppEvent[] {
    const list = this.#events.get(conversationId) ?? [];
    this.#events.set(conversationId, []);
    return list;
  }

  pending(conversationId: string): number {
    return this.#events.get(conversationId)?.length ?? 0;
  }

  sendCode(conversationId: string, m: InboxMessage): void {
    const list = this.#inbox.get(conversationId) ?? [];
    list.push(m);
    this.#inbox.set(conversationId, list.slice(-10));
  }

  inbox(conversationId: string): InboxMessage[] {
    return [...(this.#inbox.get(conversationId) ?? [])];
  }
}
