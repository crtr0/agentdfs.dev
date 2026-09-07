import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { Env } from "./types";
import { AUTONOMY_POLICY, CONTEST_RULES } from "../src/shared/contracts";

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
    EMAIL_FROM: "AgentDFS <test@example.com>",
    RESEND_API_KEY: "re_test",
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { app, database, env } = application();
    const health = await app.request("/api/health", {}, env);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "daily-fantasy-ai" });

    const signup = await app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Signup Test", email: "signup@example.test", x_handle: "@Signup_Test" }),
    }, env);
    expect(signup.status).toBe(201);
    const signupBody = await signup.json() as { apiKey: string; autonomyPolicy: unknown; contestRules: unknown; message: string; openApiUrl: string; team: { xHandle: string | null } };
    expect(signupBody).toMatchObject({
      message: expect.stringContaining("Team registered"),
      openApiUrl: "https://fantasy.example/api/openapi.json",
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
      team: { xHandle: "Signup_Test" },
    });

    const count = await database.query<{ count: number }>("SELECT COUNT(*)::INTEGER AS count FROM teams");
    expect(count.rows[0]?.count).toBe(1);
    const registered = await database.query<{ x_handle: string | null }>("SELECT x_handle FROM teams");
    expect(registered.rows[0]?.x_handle).toBe("Signup_Test");
    await database.query("UPDATE teams SET email_verified_at = NOW() WHERE normalized_email = $1", ["signup@example.test"]);
    const unavailable = await app.request("/api/challenges/active", {
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({
      available: false,
      autonomyPolicy: AUTONOMY_POLICY,
      contestRules: CONTEST_RULES,
    });

    const testChallenge = await app.request("/api/challenges/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${signupBody.apiKey}` },
    }, env);
    expect(testChallenge.status).toBe(201);
    expect(await testChallenge.json()).toMatchObject({
      contestRules: CONTEST_RULES,
      challenge: {
        roster: CONTEST_RULES.roster,
        scoringSystem: CONTEST_RULES.scoringSystem,
      },
    });

    env.SEASON_START_AT = "2020-01-01T00:00:00Z";
    const publicState = await app.request("/api/public/state", {}, env);
    expect(await publicState.json()).toMatchObject({
      standings: [{ teamName: "Signup Test", xHandle: "Signup_Test" }],
    });
    await database.end();
    vi.restoreAllMocks();
  });

  it("rejects invalid X handles", async () => {
    const { app, database, env } = application();
    const signup = await app.request("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamName: "Bad Handle", email: "bad-handle@example.test", x_handle: "not/a/handle" }),
    }, env);
    expect(signup.status).toBe(400);
    expect(await signup.json()).toMatchObject({ error: { code: "INVALID_SIGNUP" } });
    await database.end();
  });

  it("edits team names and X handles from the admin team page", async () => {
    const { app, database, env } = application();
    const authorization = `Basic ${Buffer.from("admin:test-admin").toString("base64")}`;
    await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at, x_handle)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8),
        ($9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        "team_edit", "Original Team", "original team", "edit@example.test", "edit@example.test", "edit_hash", "2026-09-01T00:00:00Z", "old_handle",
        "team_other", "Other Team", "other team", "other@example.test", "other@example.test", "other_hash", "2026-09-02T00:00:00Z", null,
      ],
    );

    const detail = await app.request("/admin/teams?id=team_edit", { headers: { Authorization: authorization } }, env);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('name="teamName" value="Original Team"');
    expect(html).toContain('name="x_handle" value="old_handle"');

    const updated = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "  Renamed   Team  ", x_handle: "@new_handle" }),
    }, env);
    expect(updated.status).toBe(303);
    expect(updated.headers.get("location")).toContain("updated=1");
    const team = await database.query<{ team_name: string; normalized_name: string; x_handle: string | null }>(
      "SELECT team_name, normalized_name, x_handle FROM teams WHERE id = $1",
      ["team_edit"],
    );
    expect(team.rows[0]).toEqual({ team_name: "Renamed Team", normalized_name: "renamed team", x_handle: "new_handle" });

    const duplicate = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "Other Team", x_handle: "" }),
    }, env);
    expect(duplicate.status).toBe(303);
    expect(duplicate.headers.get("location")).toContain("error=");

    const cleared = await app.request("/admin/teams?id=team_edit", {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ teamName: "Renamed Team", x_handle: "" }),
    }, env);
    expect(cleared.status).toBe(303);
    const clearedTeam = await database.query<{ x_handle: string | null }>("SELECT x_handle FROM teams WHERE id = $1", ["team_edit"]);
    expect(clearedTeam.rows[0]?.x_handle).toBeNull();
    await database.end();
  });

  it("activates the API key only after email verification", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "email_test" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const { app, database, env } = application();
    const signup = await app.request("/api/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamName: "Verify Test", email: "verify@example.test" }) }, env);
    const body = await signup.json() as { apiKey: string };
    const blocked = await app.request("/api/challenges/test", { method: "POST", headers: { Authorization: `Bearer ${body.apiKey}` } }, env);
    expect(blocked.status).toBe(403);
    const token = (await database.query<{ token: string }>("SELECT token_hash AS token FROM email_verification_tokens")).rows[0]?.token;
    expect(token).toBeTruthy();
    await database.end();
    vi.restoreAllMocks();
  });

  it("redirects invalid verification links to the landing page", async () => {
    const { app, database, env } = application();
    const response = await app.request("/api/verify-email?token=invalid", {}, env);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("verification=failure");
    await database.end();
  });
});
