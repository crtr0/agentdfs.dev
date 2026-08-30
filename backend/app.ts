import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { apiError } from "./lib/http";
import { openApiDocument } from "./openapi";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { challengeRoutes } from "./routes/challenges";
import { publicRoutes } from "./routes/public";
import type { AppVariables, Env } from "./types";

export function createApp(env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.use("*", requestId());
  app.use("*", logger());
  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  }));

  app.get("/api/health", (c) => c.json({
    message: "Service is healthy.",
    status: "ok",
    service: "daily-fantasy-ai",
    time: new Date().toISOString(),
  }));

  app.route("/", adminRoutes);
  app.route("/api", authRoutes);
  app.route("/api", challengeRoutes);
  app.route("/api", publicRoutes);
  app.get("/api/openapi.json", (c) => c.json(openApiDocument(c.env.APP_BASE_URL)));

  app.use("/assets/*", serveStatic({ root: "./dist" }));
  app.get("/", serveStatic({ path: "./dist/index.html" }));

  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "Route not found."));
  app.onError((error, c) => {
    console.error(error);
    return apiError(c, 500, "INTERNAL_ERROR", "An unexpected error occurred.");
  });

  return app;
}
