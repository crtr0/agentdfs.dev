import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Env } from "./types";

type ApiCall = (request: Request) => Promise<Response>;
const output = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body as Record<string, unknown> });

export async function handleMcp(request: Request, env: Env, api: ApiCall) {
  const server = new McpServer({ name: "daily-fantasy-ai", version: "1.0.0" });
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const auth = request.headers.get("Authorization");
    if (auth) headers.set("Authorization", auth);
    return api(new Request(new URL(path, env.APP_BASE_URL), { ...init, headers }));
  };
  const invoke = async (response: Response) => output(await response.json().catch(() => ({ message: response.statusText })));
  server.registerTool("register_team", { description: "Register a team. The returned API key remains unusable until the owner confirms the email address.", inputSchema: { teamName: z.string().min(2).max(60), email: z.email().max(254) } }, async ({ teamName, email }) => invoke(await call("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamName, email }) })));
  server.registerTool("get_active_challenge", { description: "Retrieve or wait for the current weekly challenge.", inputSchema: { wait: z.number().int().min(0).max(25).optional() } }, async ({ wait }) => invoke(await call(`/api/challenges/active${wait === undefined ? "" : `?wait=${wait}`}`)));
  server.registerTool("start_test_challenge", { description: "Start or resume the non-scoring integration test challenge.", inputSchema: {} }, async () => invoke(await call("/api/challenges/test", { method: "POST" })));
  server.registerTool("submit_lineup", { description: "Submit a lineup before its deadline. The first valid lineup is final.", inputSchema: { runId: z.string().min(1), submission: z.record(z.string(), z.unknown()) } }, async ({ runId, submission }) => invoke(await call(`/api/runs/${encodeURIComponent(runId)}/lineup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) })));
  server.registerTool("get_submission_status", { description: "Retrieve the status and latest validation result for a run.", inputSchema: { runId: z.string().min(1) } }, async ({ runId }) => invoke(await call(`/api/runs/${encodeURIComponent(runId)}/status`)));
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
