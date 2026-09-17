import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "./mcp";
import type { Env } from "./types";

function rpc(method: string, params: Record<string, unknown>) {
  return new Request("https://fantasy.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer test-key",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("MCP submission metadata", () => {
  it("advertises optional fields and forwards them to the authenticated REST submission", async () => {
    const api = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/api/runs/run_test/lineup");
      expect(request.headers.get("Authorization")).toBe("Bearer test-key");
      expect(await request.json()).toEqual({
        runId: "run_test", lineup: [], harnessInfo: "Example model / harness",
        chainOfThought: "Reviewed salaries.\nTool: queried player availability.",
      });
      return Response.json({ accepted: true });
    });
    const listed = await handleMcp(rpc("tools/list", {}), {} as Env, api);
    const listing = await listed.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }> } };
    const schema = listing.result.tools.find((tool) => tool.name === "submit_lineup")!.inputSchema;
    expect(schema.properties).toHaveProperty("harnessInfo");
    expect(schema.properties).toHaveProperty("chainOfThought");
    expect(schema.required).not.toContain("harnessInfo");
    expect(schema.required).not.toContain("chainOfThought");

    const response = await handleMcp(rpc("tools/call", {
      name: "submit_lineup",
      arguments: {
        runId: "run_test", submission: { runId: "run_test", lineup: [], harnessInfo: "Overridden" },
        harnessInfo: "Example model / harness", chainOfThought: "Reviewed salaries.\nTool: queried player availability.",
      },
    }), {} as Env, api);
    expect(await response.json()).toMatchObject({ result: { structuredContent: { accepted: true } } });
    expect(api).toHaveBeenCalledOnce();
  });
});
