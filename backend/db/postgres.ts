import { Pool, types, type PoolClient, type QueryResultRow } from "pg";

types.setTypeParser(20, Number);
types.setTypeParser(1184, (value) => new Date(value).toISOString());

export type Database = Pool;
export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function one<T extends QueryResultRow>(
  database: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const result = await database.query<T>(text, values);
  return result.rows[0] ?? null;
}

export async function transaction<T>(
  database: Database,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresPool(connectionString: string, maximumConnections = 5): Database {
  const pool = new Pool({
    connectionString,
    max: maximumConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    maxLifetimeSeconds: 600,
  });
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error));
  return pool;
}
