import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileChallengeNotifications } from "./challenge-notifications";
import { createChallenge } from "./challenges";
import { reconcileChallengeLifecycle } from "../scheduler";
import type { Env } from "../types";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }));

async function environment() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const directory = resolve(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
    memory.public.none(readFileSync(resolve(directory, name), "utf8"));
  }
  const adapter = memory.adapters.createPg();
  const env: Env = {
    DB: new adapter.Pool() as unknown as Pool,
    APP_BASE_URL: "https://fantasy.example", RESEND_API_KEY: "test-key", EMAIL_FROM: "AgentDFS <game@example.test>",
    CURRENT_SEASON: "2099", SEASON_START_AT: "2099-09-10T00:20:00Z",
    SEASON_END_AT: "2100-01-11T23:59:59Z", USE_FIXTURES: "true",
  };
  await env.DB.query(`INSERT INTO teams
    (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at, email_verified_at)
    VALUES ('team_a', 'A', 'a', 'a@example.test', 'a@example.test', 'hash_a', '2099-08-01', '2099-08-01'),
           ('team_b', 'B', 'b', 'b@example.test', 'b@example.test', 'hash_b', '2099-08-01', NULL)`);
  return env;
}

async function challenge(env: Env, week = 1, season = 2099, releasedAt = "2099-09-01T00:00:00Z") {
  return createChallenge(env.DB, {
    id: `challenge_${season}_${week}`, season, week, releasedAt,
    deadlineAt: "2099-09-10T00:05:00Z", firstGameAt: "2099-09-10T00:20:00Z",
  });
}

describe("weekly opening announcements", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-09-01T12:00:00Z"));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("announces to every registered team once, including teams joining an open week", async () => {
    const env = await environment();
    await challenge(env);
    const send = vi.fn(async () => Response.json({ id: "email_1" }));
    vi.stubGlobal("fetch", send);
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 2, sent: 2, failed: 0 });
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const requests = vi.mocked(fetch).mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(requests.map((request) => request.to)).toEqual([["a@example.test"], ["b@example.test"]]);
    expect(requests[0].text).toContain("Start your agent's run before:");
    expect(requests[0].text).toContain("2099-09-10T00:00:00.000Z");
    expect(requests[0].text).toContain("Final submission cutoff:");
    expect(requests[0].text).toContain("2099-09-10T00:05:00.000Z");
    expect(requests[0].text).toContain("300 seconds");
    expect(requests[0].text).toContain("https://fantasy.example");
    expect(requests[0].text).toContain("PDT");
    expect(requests[0].text).toContain("EDT");

    await env.DB.query(`INSERT INTO teams
      (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
      VALUES ('team_c', 'C', 'c', 'c@example.test', 'c@example.test', 'hash_c', '2099-09-02')`);
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 1, sent: 1, failed: 0 });
    await env.DB.query("DELETE FROM challenges WHERE season = 2099 AND week = 1");
    await challenge(env); // A packet refresh must not erase delivery history.
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 0, sent: 0, failed: 0 });
    await env.DB.end();
  });

  it("only announces released, enterable live-season challenges", async () => {
    const env = await environment();
    await challenge(env, 0, 0);
    await challenge(env, 1, 2098);
    await challenge(env, 1, 2099, "2099-09-02T00:00:00Z");
    const send = vi.fn(async () => Response.json({ id: "email_1" }));
    vi.stubGlobal("fetch", send);
    expect((await reconcileChallengeNotifications(env)).queued).toBe(0);
    vi.setSystemTime(new Date("2099-09-02T00:00:00Z"));
    await reconcileChallengeLifecycle(env);
    expect((await reconcileChallengeNotifications(env)).sent).toBe(2);
    await challenge(env, 2);
    await env.DB.query("UPDATE challenges SET status = 'closed' WHERE week = 2");
    expect((await reconcileChallengeNotifications(env)).queued).toBe(0);
    await env.DB.query("UPDATE challenges SET status = 'open' WHERE week = 2");
    vi.setSystemTime(new Date("2099-09-10T00:00:00Z")); // Entry closes before the global deadline.
    expect((await reconcileChallengeNotifications(env)).queued).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    await env.DB.end();
  });

  it("retries failed recipients without resending successes and expires late retries", async () => {
    const env = await environment();
    await challenge(env);
    const send = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "email_b" }))
      .mockResolvedValueOnce(Response.json({ id: "email_a" }));
    vi.stubGlobal("fetch", send);
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 2, sent: 1, failed: 1 });
    expect((await reconcileChallengeNotifications(env)).sent).toBe(0);
    vi.setSystemTime(new Date("2099-09-01T12:01:00Z"));
    expect(await reconcileChallengeNotifications(env)).toEqual({ queued: 0, sent: 1, failed: 0 });
    expect(send.mock.calls[2]![1].headers["Idempotency-Key"]).toBe(send.mock.calls[0]![1].headers["Idempotency-Key"]);
    expect(send.mock.calls[2]![1].body).toBe(send.mock.calls[0]![1].body);

    await challenge(env, 2);
    send.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await reconcileChallengeNotifications(env);
    const attempts = send.mock.calls.length;
    vi.setSystemTime(new Date("2099-09-10T00:00:00Z"));
    await reconcileChallengeNotifications(env);
    expect(send).toHaveBeenCalledTimes(attempts);
    const expired = await env.DB.query("SELECT status FROM challenge_notifications WHERE week = 2");
    expect(expired.rows.map((row) => row.status)).toEqual(["expired", "expired"]);
    await env.DB.end();
  });

  it("stops uncertain retries before the provider's idempotency window expires", async () => {
    const env = await environment();
    await challenge(env);
    const send = vi.fn().mockRejectedValue(new Error("Connection lost"));
    vi.stubGlobal("fetch", send);
    await reconcileChallengeNotifications(env);
    vi.setSystemTime(new Date("2099-09-02T11:00:00Z"));
    expect((await reconcileChallengeNotifications(env)).failed).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    const records = await env.DB.query("SELECT status FROM challenge_notifications");
    expect(records.rows.map((row) => row.status)).toEqual(["failed", "failed"]);
    await env.DB.end();
  });

  it("reuses the saved payload and key when a send succeeds but saving its result fails", async () => {
    const env = await environment();
    await challenge(env);
    const send = vi.fn().mockImplementation(async () => Response.json({ id: "email_a" }));
    vi.stubGlobal("fetch", send);
    const query = env.DB.query.bind(env.DB);
    const failingQuery = vi.spyOn(env.DB, "query").mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes("SET status = 'sent'")) throw new Error("Database connection lost");
      return (query as (...values: unknown[]) => ReturnType<typeof env.DB.query>)(...args);
    });
    await expect(reconcileChallengeNotifications(env)).rejects.toThrow("Database connection lost");
    failingQuery.mockRestore();

    env.EMAIL_FROM = "New sender <new@example.test>";
    vi.setSystemTime(new Date("2099-09-01T12:01:00Z"));
    expect((await reconcileChallengeNotifications(env)).sent).toBe(2);
    const attempts = send.mock.calls.filter((call) => call[1].headers["Idempotency-Key"].endsWith("/team_a"));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]![1].body).toBe(attempts[0]![1].body);
    expect(attempts[1]![1].headers["Idempotency-Key"]).toBe(attempts[0]![1].headers["Idempotency-Key"]);
    await env.DB.end();
  });

  it("does not queue or send without email configuration", async () => {
    const env = await environment();
    await challenge(env);
    env.RESEND_API_KEY = undefined;
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    expect(await reconcileChallengeNotifications(env)).toMatchObject({ skipped: "email-not-configured" });
    expect(send).not.toHaveBeenCalled();
    await env.DB.end();
  });
});
