import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

interface AppliedMigration {
  name: string;
  checksum: string;
}

export function databaseConnectionString(source: NodeJS.ProcessEnv = process.env): string {
  const connectionString = source.DIRECT_DATABASE_URL?.trim() || source.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DIRECT_DATABASE_URL or DATABASE_URL is required.");
  return connectionString;
}

export async function runMigrations(connectionString = databaseConnectionString()): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL
    )`);
    const migrationsDirectory = resolve(process.cwd(), "migrations");
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    const appliedResult = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(appliedResult.rows.map((migration) => [migration.name, migration.checksum]));

    for (const name of files) {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existingChecksum = applied.get(name);
      if (existingChecksum && existingChecksum !== checksum) {
        throw new Error(`Migration ${name} was modified after it was applied.`);
      }
      if (existingChecksum) continue;

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3)",
          [name, checksum, new Date().toISOString()],
        );
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
