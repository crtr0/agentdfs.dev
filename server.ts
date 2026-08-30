import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./backend/app";
import { loadConfig } from "./backend/config";
import { createPostgresPool } from "./backend/db/postgres";
import { startScheduler } from "./backend/scheduler";

const config = loadConfig();
const database = createPostgresPool(config.DATABASE_URL, config.DB_POOL_MAX);
const env = { ...config, DB: database };
const app = createApp(env);
const scheduler = startScheduler(env);

const server = serve({
  fetch: (request) => app.fetch(request, env),
  hostname: "0.0.0.0",
  port: config.PORT,
}, ({ address, port }) => {
  console.log(`daily-fantasy-ai listening on http://${address}:${port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await scheduler.stop();
    await database.end();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
