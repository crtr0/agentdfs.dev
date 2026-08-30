import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { databaseConnectionString, runMigrations } from "./migrations";

if (process.env.ALLOW_DATABASE_RESET !== "true") {
  throw new Error("Set ALLOW_DATABASE_RESET=true to confirm a destructive database reset.");
}

const connectionString = databaseConnectionString();
const pool = new Pool({ connectionString, max: 1 });
try {
  const sql = await readFile(resolve(process.cwd(), "reset.sql"), "utf8");
  await pool.query(sql);
} finally {
  await pool.end();
}

await runMigrations(connectionString);
console.log("Database reset completed.");
