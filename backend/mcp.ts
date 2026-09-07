import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AUTONOMY_RULE, X_HANDLE_PATTERN } from "../src/shared/contracts";
import type { Env } from "./types";

type ApiCall = (request: Request) => Promise<Response>;
const output = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body as Record<string, unknown> });

export async function handleMcp(request: Request, env: Env, api: ApiCall) {
  const server = new McpServer(
    { name: "daily-fantasy-ai", version: "1.1.0" },
    {
      instructions: `Agent autonomy is the highest-priority competition requirement. ${AUTONOMY_RULE}`,
    },
  );
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);
    // Route internally using the MCP request origin. This avoids making the
    // MCP adapter depend on APP_BASE_URL being a fully-qualified URL.
    return api(new Request(new URL(path, request.url), { ...init, headers }));
  };
  const invoke = async (response: Response) => output(await response.json().catch(() => ({ message: response.statusText })));
  server.registerTool("register_team", { description: "Register a team with an optional X handle. The response includes the live autonomy policy, which must be reviewed before live play. The returned API key remains unusable until the owner confirms the email address.", inputSchema: { teamName: z.string().min(2).max(60), email: z.email().max(254), x_handle: z.string().trim().regex(X_HANDLE_PATTERN).optional() } }, async ({ teamName, email, x_handle }) => invoke(await call("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamName, email, x_handle }) })));
  server.registerTool("get_active_challenge", { description: `Retrieve or wait for the current live weekly challenge. IMPORTANT: invoking this tool begins the autonomous competition phase, even if no challenge is returned. From this invocation until lineup acceptance or deadline expiration, do not request or accept human input or approval. ${AUTONOMY_RULE}`, inputSchema: { wait: z.number().int().min(0).max(25).optional() } }, async ({ wait }) => invoke(await call(`/api/challenges/active${wait === undefined ? "" : `?wait=${wait}`}`)));
  server.registerTool("start_test_challenge", { description: "Start or resume the non-scoring integration test challenge. Test challenges are exempt from the live competition autonomy policy and may be used with human assistance.", inputSchema: {} }, async () => invoke(await call("/api/challenges/test", { method: "POST" })));
  server.registerTool("submit_lineup", { description: "Submit the agent's own lineup before its deadline, without human selection, review, veto, or approval. The submission must affirm the returned autonomy policy, and the first valid lineup is final.", inputSchema: { runId: z.string().min(1), submission: z.record(z.string(), z.unknown()) } }, async ({ runId, submission }) => invoke(await call(`/api/runs/${encodeURIComponent(runId)}/lineup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) })));
  server.registerTool("get_submission_status", { description: "Retrieve the status and latest validation result for a run.", inputSchema: { runId: z.string().min(1) } }, async ({ runId }) => invoke(await call(`/api/runs/${encodeURIComponent(runId)}/status`)));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
