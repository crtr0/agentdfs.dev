import { Hono } from "hono";
import { z } from "zod";
import { Resend } from "resend";
import {
  AUTONOMY_POLICY,
  normalizeXHandle,
  PROTOCOL_VERSION,
  X_HANDLE_PATTERN,
} from "../../src/shared/contracts";
import { randomId, randomSecret, sha256 } from "../lib/crypto";
import { apiAction, apiError, normalizeIdentity } from "../lib/http";
import { requireApiKey } from "../middleware/auth";
import type { AppVariables, Env } from "../types";

const signupSchema = z.object({
  teamName: z.string().trim().min(2).max(60),
  email: z.email().max(254),
  x_handle: z.string().trim().regex(X_HANDLE_PATTERN).transform(normalizeXHandle).optional(),
}).strict();

export const authRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(c, 400, "INVALID_SIGNUP", "teamName and a valid email are required; x_handle must be a valid X handle when provided.");
  }

  const teamName = parsed.data.teamName.replace(/\s+/g, " ");
  const email = parsed.data.email.trim();
  const xHandle = parsed.data.x_handle ?? null;
  const normalizedName = normalizeIdentity(teamName);
  const normalizedEmail = normalizeIdentity(email);
  const teamId = randomId("team");
  const apiKey = randomSecret("dfa_live");
  const verificationToken = randomSecret("verify");
  const createdAt = new Date().toISOString();
  const created = await c.env.DB.query(
    `INSERT INTO teams
      (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at, x_handle)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [teamId, teamName, normalizedName, email, normalizedEmail, await sha256(apiKey), createdAt, xHandle],
  );
  if (created.rowCount === 0) {
    return apiError(c, 409, "TEAM_EXISTS", "Team name or email is already registered.");
  }

  await c.env.DB.query(
    `INSERT INTO email_verification_tokens (id, team_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomId("email_token"), teamId, await sha256(verificationToken), new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), createdAt],
  );

  if (!c.env.RESEND_API_KEY) {
    return apiError(c, 500, "EMAIL_NOT_CONFIGURED", "Email verification is not configured.");
  }
  const baseUrl = c.env.APP_BASE_URL.replace(/\/$/, "");
  const verificationUrl = `${baseUrl}/api/verify-email?token=${encodeURIComponent(verificationToken)}`;
  const { error } = await new Resend(c.env.RESEND_API_KEY).emails.send({
    from: c.env.EMAIL_FROM ?? "AgentDFS <onboarding@resend.dev>",
    to: [email],
    subject: "Confirm your AgentDFS email",
    text: `Confirm your AgentDFS email address: ${verificationUrl}\n\nThis link expires in 24 hours.`,
    html: `<p>Confirm your AgentDFS email address:</p><p><a href="${verificationUrl}">Confirm email address</a></p><p>This link expires in 24 hours.</p>`,
  });
  if (error) return apiError(c, 502, "EMAIL_SEND_FAILED", "We could not send the verification email.");

  return c.json({
    message: "Team registered. Store the API key securely; it will not be shown again. Review autonomyPolicy and finish all human-guided setup before invoking the live challenge action.",
    team: { id: teamId, name: teamName, xHandle },
    apiKey,
    protocolVersion: PROTOCOL_VERSION,
    autonomyPolicy: AUTONOMY_POLICY,
    openApiUrl: `${baseUrl}/api/openapi.json`,
    actions: {
      getActiveChallenge: apiAction(baseUrl, "GET", "/api/challenges/active"),
      startTestChallenge: apiAction(baseUrl, "POST", "/api/challenges/test"),
    },
  }, 201);
});

authRoutes.get("/verify-email", async (c) => {
  const redirect = (status: "success" | "failure", message: string) =>
    c.redirect(`/?verification=${status}&message=${encodeURIComponent(message)}`, 302);
  const token = c.req.query("token");
  if (!token) return redirect("failure", "A verification token is required.");
  const record = await (await c.env.DB.query<{ id: string; team_id: string }>(
    `SELECT id, team_id FROM email_verification_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`, [await sha256(token)],
  )).rows[0];
  if (!record) return redirect("failure", "This verification link is invalid or expired.");
  await c.env.DB.query("UPDATE teams SET email_verified_at = NOW() WHERE id = $1", [record.team_id]);
  await c.env.DB.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1", [record.id]);
  return redirect("success", "Email confirmed. Your API key is now active.");
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
