import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { databaseConnectionString, runMigrations } from "./migrations";

const connectionString = databaseConnectionString();
await runMigrations(connectionString);

const pool = new Pool({ connectionString, max: 1 });
try {
  const sql = await readFile(resolve(process.cwd(), "seed.sql"), "utf8");
  await pool.query(sql);
  console.log("Seed data loaded.");
} finally {
  await pool.end();
}
