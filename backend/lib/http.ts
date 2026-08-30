import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json({ message, error: { code, message } }, status);
}

export function normalizeIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function apiAction(
  appBaseUrl: string,
  method: "GET" | "POST",
  path: string,
) {
  return {
    method,
    url: `${appBaseUrl.replace(/\/$/, "")}${path}`,
    authorization: { scheme: "Bearer" as const, credential: "apiKey" as const },
  };
}
