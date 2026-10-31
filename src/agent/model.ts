// The chat model behind the agent: any OpenAI-compatible /chat/completions endpoint (LLM_BASE_URL,
// LLM_API_KEY, LLM_MODEL; OpenRouter planned), or the scripted model when no key is set. Both speak the
// same message format, so the loop does not care which one runs.

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text, as the API sends it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ModelReply {
  content: string | null;
  tool_calls: ToolCall[];
}

export interface ChatModel {
  readonly label: string;
  complete(messages: ChatMessage[], tools: unknown[]): Promise<ModelReply>;
}

export class ModelError extends Error {
  override name = "ModelError";
}

export class OpenAICompatModel implements ChatModel {
  readonly label: string;
  readonly #base: string;
  readonly #key: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(o: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }) {
    const u = new URL(o.baseUrl);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("LLM_BASE_URL must be https");
    this.#base = o.baseUrl.replace(/\/+$/, "");
    this.#key = o.apiKey;
    this.#model = o.model;
    this.#fetch = o.fetch ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 45_000;
    this.label = `${o.model} via ${u.host}`;
  }

  toJSON() {
    return { label: this.label };
  }

  async complete(messages: ChatMessage[], tools: unknown[]): Promise<ModelReply> {
    const wire = messages.map((m) =>
      m.role === "assistant" && m.tool_calls?.length
        ? { role: "assistant", content: m.content, tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
        : m,
    );
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.#model, messages: wire, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 700 }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ModelError("The model did not answer in time.");
    }
    if (!res.ok) throw new ModelError(`The model endpoint answered HTTP ${res.status}.`);
    const body = (await res.json().catch(() => undefined)) as
      | { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> }
      | undefined;
    const msg = body?.choices?.[0]?.message;
    if (!msg) throw new ModelError("The model reply had no message.");
    return {
      content: msg.content ?? null,
      tool_calls: (msg.tool_calls ?? []).filter((c) => c.function?.name).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.function!.name!, arguments: c.function!.arguments ?? "{}" })),
    };
  }
}
