import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Env } from "./types";

function application() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const directory = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    memory.public.none(readFileSync(resolve(directory, name), "utf8"));
  }
  const adapter = memory.adapters.createPg();
  const database = new adapter.Pool() as unknown as Pool;
  const env: Env = {
    DB: database,
    APP_BASE_URL: "https://fantasy.example",
    ADMIN_SECRET: "test-admin",
    CURRENT_SEASON: "2026",
    SEASON_START_AT: "2026-09-10T00:00:00Z",
    SEASON_END_AT: "2027-01-11T23:59:59Z",
    CHALLENGE_WINDOW_SECONDS: "300",
    FANTASYNERDS_BASE_URL: "https://api.fantasynerds.com",
    USE_FIXTURES: "true",
  };
  return { app: createApp(env), database, env };
}

describe("Node application", () => {
  it("serves health checks and writes signups to PostgreSQL", async () => {
    const { app, database, env } = application();
    const health = await app.request("/api/health", {}, env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "daily-fantasy-ai" });

    const signup = await app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Signup Test", email: "signup@example.test" }),
    }, env);
    expect(signup.status).toBe(201);
    expect(await signup.json()).toMatchObject({
      message: expect.stringContaining("Team registered"),
      openApiUrl: "https://fantasy.example/api/openapi.json",
    });

    const count = await database.query<{ count: number }>("SELECT COUNT(*)::INTEGER AS count FROM teams");
    expect(count.rows[0]?.count).toBe(1);
    await database.end();
  });
});
