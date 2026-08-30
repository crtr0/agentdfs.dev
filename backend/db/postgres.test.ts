import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { one, transaction } from "./postgres";

function testDatabase() {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool() as unknown as Pool;
  return { memory, database: pool };
}

describe("PostgreSQL database", () => {
  it("applies the schema and queries typed rows", async () => {
    const { memory, database } = testDatabase();
    const directory = resolve(process.cwd(), "migrations");
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".sql")).sort()) {
      memory.public.none(readFileSync(resolve(directory, name), "utf8"));
    }

    const insert = await database.query(
      `INSERT INTO teams
        (id, team_name, normalized_name, email, normalized_email, api_key_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        "team_test",
        "Test Team",
        "test team",
        "test@example.test",
        "test@example.test",
        "hash_test",
        "2026-08-29T00:00:00.000Z",
      ],
    );
    expect(insert.rowCount).toBe(1);

    const row = await one<{ team_name: string }>(
      database,
      "SELECT team_name FROM teams WHERE id = $1",
      ["team_test"],
    );
    expect(row).toEqual({ team_name: "Test Team" });
    await database.end();
  });

  it("rolls back every statement when a batch fails", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("missing")) throw new Error("query failed");
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const pool = {
      connect: async () => client,
      query: client.query,
      end: async () => {},
      on: () => pool,
    } as unknown as Pool;
    await expect(transaction(pool, async (transactionClient) => {
      await transactionClient.query("INSERT INTO values_test (id) VALUES ($1)", ["first"]);
      await transactionClient.query("INSERT INTO values_test (missing) VALUES ($1)", ["failure"]);
    })).rejects.toThrow();

    expect(queries).toEqual([
      "BEGIN",
      "INSERT INTO values_test (id) VALUES ($1)",
      "INSERT INTO values_test (missing) VALUES ($1)",
      "ROLLBACK",
    ]);
  });
});
