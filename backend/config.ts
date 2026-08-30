import type { Env } from "./types";

export interface RuntimeConfig extends Omit<Env, "DB"> {
  DATABASE_URL: string;
  DB_POOL_MAX: number;
  PORT: number;
}

function value(source: NodeJS.ProcessEnv, name: string, fallback = ""): string {
  return source[name]?.trim() || fallback;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const result = value(source, name);
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function positiveInteger(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const result = Number(value(source, name, String(fallback)));
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    DATABASE_URL: required(source, "DATABASE_URL"),
    DB_POOL_MAX: positiveInteger(source, "DB_POOL_MAX", 5),
    PORT: positiveInteger(source, "PORT", 8080),
    APP_BASE_URL: value(source, "APP_BASE_URL", "http://127.0.0.1:8080"),
    ADMIN_SECRET: value(source, "ADMIN_SECRET") || undefined,
    CURRENT_SEASON: value(source, "CURRENT_SEASON", "2026"),
    SEASON_START_AT: value(source, "SEASON_START_AT", "2026-09-10T00:00:00Z"),
    SEASON_END_AT: value(source, "SEASON_END_AT", "2027-01-11T23:59:59Z"),
    CHALLENGE_WINDOW_SECONDS: value(source, "CHALLENGE_WINDOW_SECONDS", "300"),
    FANTASYNERDS_API_KEY: value(source, "FANTASYNERDS_API_KEY") || undefined,
    FANTASYNERDS_BASE_URL: value(source, "FANTASYNERDS_BASE_URL", "https://api.fantasynerds.com"),
    FANTASYNERDS_OPERATOR: value(source, "FANTASYNERDS_OPERATOR", "Yahoo"),
    FANTASYNERDS_SLATE_NAME: value(source, "FANTASYNERDS_SLATE_NAME"),
    USE_FIXTURES: value(source, "USE_FIXTURES", "false"),
  };
}
