import { createMiddleware } from "hono/factory";
import { one } from "../db/postgres";
import { sha256 } from "../lib/crypto";
import { apiError, bearerToken } from "../lib/http";
import type { AppVariables, Env, TeamRecord } from "../types";

export const requireApiKey = createMiddleware<{
  Bindings: Env;
  Variables: AppVariables;
}>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) return apiError(c, 401, "INVALID_CREDENTIALS", "A valid API key is required.");

  const hash = await sha256(token);
  const team = await one<TeamRecord>(
    c.env.DB,
    "SELECT id, team_name, email, api_key_hash, created_at FROM teams WHERE api_key_hash = $1",
    [hash],
  );

  if (!team) return apiError(c, 401, "INVALID_CREDENTIALS", "A valid API key is required.");
  c.set("team", team);
  await next();
});
