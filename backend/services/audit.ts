import { randomId, sha256, stableStringify } from "../lib/crypto";
import { one, transaction, type Database } from "../db/postgres";

export async function appendAuditEvent(
  db: Database,
  runId: string,
  eventType: string,
  metadata: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
): Promise<string> {
  return transaction(db, async (client) => {
    // Serialize each run's audit chain so concurrent submissions cannot fork it.
    await client.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [runId]);
    const previous = await one<{ event_hash: string }>(
      client,
      "SELECT event_hash FROM audit_events WHERE run_id = $1 ORDER BY sequence DESC LIMIT 1",
      [runId],
    );
    const previousHash = previous?.event_hash ?? null;
    const eventHash = await sha256(
      stableStringify({ runId, eventType, occurredAt, metadata, previousHash }),
    );

    await client.query(
      `INSERT INTO audit_events
        (id, run_id, event_type, occurred_at, metadata, previous_hash, event_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomId("audit"),
        runId,
        eventType,
        occurredAt,
        metadata,
        previousHash,
        eventHash,
      ],
    );

    return eventHash;
  });
}
