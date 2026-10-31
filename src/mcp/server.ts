// The same tools over MCP (stateless Streamable HTTP at POST /mcp). An MCP client is one more caller of
// the booking service: it can request, quote and create orders only inside a mandate that a traveller
// approved on the page. MCP bookings share the conversation id "mcp" in this demo.

import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Tool, type ToolContext, TOOLS, runTool } from "../tools/registry.ts";

export const SERVER_NAME = "ambree-paypal";
export const MCP_CONVERSATION = "mcp";

export function buildMcpServer(ctx: Omit<ToolContext, "conversationId">, version: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: "Ambree: book a local guide, pay them via PayPal", version },
    {
      instructions:
        "Find and book independent guides in Mauritius. Payments go from the traveller straight to the guide's own PayPal account (sandbox). create_order works only after the traveller approved a mandate on the Ambree page.",
    },
  );
  for (const tool of TOOLS as readonly Tool[]) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: { readOnlyHint: !tool.moneyMoving && ["search_guides", "get_booking", "get_order", "check_weather"].includes(tool.name), destructiveHint: tool.moneyMoving, openWorldHint: true },
      },
      async (args: unknown): Promise<CallToolResult> => {
        const out = await runTool(tool.name, args, { ...ctx, conversationId: MCP_CONVERSATION });
        return out.ok ? { content: [{ type: "text", text: JSON.stringify(out.value) }], structuredContent: out.value } : { content: [{ type: "text", text: out.message }], isError: true };
      },
    );
  }
  return server;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown, ctx: Omit<ToolContext, "conversationId">, version: string): Promise<void> {
  const server = buildMcpServer(ctx, version);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
