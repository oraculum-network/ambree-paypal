// 3 Nov smoke test on paypal.ambree.ai: the live model wrote markdown (**bold**, numbered lists) and the page
// shows text as typed, so judges saw raw asterisks. The prompt asks for plain text.
import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/agent/loop.ts";

describe("the agent writes plain text", () => {
  it("the system prompt asks for no markdown", () => {
    expect(systemPrompt("2026-11-03")).toMatch(/plain text, no markdown/);
  });
});
