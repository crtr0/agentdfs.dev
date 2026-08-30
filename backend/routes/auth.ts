import { Hono } from "hono";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../../src/shared/contracts";
import { randomId, randomSecret, sha256 } from "../lib/crypto";
import { apiAction, apiError, normalizeIdentity } from "../lib/http";
import { requireApiKey } from "../middleware/auth";
import type { AppVariables, Env } from "../types";

const signupSchema = z.object({
  teamName: z.string().trim().min(2).max(60),
  email: z.email().max(254),
}).strict();

export const authRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, "INVALID_SIGNUP", "teamName and a valid email are required.");
  }

  const teamName = parsed.data.teamName.replace(/\s+/g, " ");
  const email = parsed.data.email.trim();
  const normalizedName = normalizeIdentity(teamName);
  const normalizedEmail = normalizeIdentity(email);
  const teamId = randomId("team");
  const apiKey = randomSecret("dfa_live");
  const createdAt = new Date().toISOString();
  const created = await c.env.DB.query(
    `INSERT INTO teams
      (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [teamId, teamName, normalizedName, email, normalizedEmail, await sha256(apiKey), createdAt],
  );
  if (created.rowCount === 0) {
    return apiError(c, 409, "TEAM_EXISTS", "Team name or email is already registered.");
  }

  const baseUrl = c.env.APP_BASE_URL.replace(/\/$/, "");

  return c.json({
    message: "Team registered. Store the API key securely; it will not be shown again.",
    team: { id: teamId, name: teamName },
    apiKey,
    protocolVersion: PROTOCOL_VERSION,
    openApiUrl: `${baseUrl}/api/openapi.json`,
    actions: {
      getActiveChallenge: apiAction(baseUrl, "GET", "/api/challenges/active"),
      startTestChallenge: apiAction(baseUrl, "POST", "/api/challenges/test"),
    },
  }, 201);
});

authRoutes.post("/keys/rotate", requireApiKey, async (c) => {
  const team = c.get("team");
  const apiKey = randomSecret("dfa_live");
  await c.env.DB.query("UPDATE teams SET api_key_hash = $1 WHERE id = $2", [await sha256(apiKey), team.id]);
  return c.json({
    message: "API key rotated. Store the new key securely; the previous key is no longer valid.",
    teamId: team.id,
    apiKey,
  });
});
