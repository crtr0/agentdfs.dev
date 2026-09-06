import { z } from "zod";
import {
  PROTOCOL_VERSION,
  ROSTER_RULES,
  SALARY_CAP,
  SLOTS,
  type LineupEntry,
  type ValidationError,
  type RosterRule,
} from "../../src/shared/contracts";
import { randomId, sha256, stableStringify } from "../lib/crypto";
import { one, transaction, type Database } from "../db/postgres";
import { appendAuditEvent } from "./audit";
import type { ChallengeRecord, RunRecord } from "../types";

const submissionSchema = z.object({
  protocolVersion: z.string(),
  runId: z.string().min(1),
  nonce: z.string().min(1),
  lineup: z.array(z.object({
    selectionId: z.string().min(1),
    slot: z.string().min(1),
  }).strict()),
}).strict();

export interface SelectionRecord {
  selection_id: string;
  player_id: string;
  name: string;
  position: string;
  eligible_slots: string[];
  price: number;
}

interface AcceptedLineup {
  id: string;
  lineup_hash: string;
  total_cost: number;
  accepted_at: string;
}

export type SubmissionResult =
  | { status: 200; body: Record<string, unknown> }
  | {
      status: 404 | 409 | 410;
      body: { message: string; error: { code: string; message: string } };
    }
  | {
      status: 422;
      body: { message: string; accepted: false; deadlineAt: string; errors: ValidationError[] };
    };

async function recordAttempt(
  db: Database,
  runId: string,
  receivedAt: string,
  transport: string,
  payloadHash: string,
  status: string,
  errors: ValidationError[],
) {
  await db.query(
    `INSERT INTO attempts
      (id, run_id, received_at, transport, payload_hash, status, validation_errors)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomId("attempt"), runId, receivedAt, transport, payloadHash, status, errors],
  );
}

function error(code: string, message: string): ValidationError {
  return { code, message };
}

export function validateLineup(
  parsed: z.infer<typeof submissionSchema>,
  routeRunId: string,
  run: RunRecord,
  selections: SelectionRecord[],
  roster: readonly RosterRule[] = ROSTER_RULES,
): { errors: ValidationError[]; totalCost: number; entries: Array<LineupEntry & SelectionRecord> } {
  const errors: ValidationError[] = [];
  if (parsed.protocolVersion !== PROTOCOL_VERSION) {
    errors.push(error("SCHEMA_INVALID", `protocolVersion must be ${PROTOCOL_VERSION}.`));
  }
  if (parsed.runId !== routeRunId || parsed.runId !== run.id) {
    errors.push(error("RUN_MISMATCH", "The body runId must match the requested run."));
  }
  if (parsed.nonce !== run.nonce) {
    errors.push(error("NONCE_MISMATCH", "The nonce does not match this run."));
  }

  const selectionMap = new Map(selections.map((selection) => [selection.selection_id, selection]));
  const entries: Array<LineupEntry & SelectionRecord> = [];
  for (const item of parsed.lineup) {
    const selection = selectionMap.get(item.selectionId);
    if (!selection) {
      errors.push(error("UNKNOWN_SELECTION", `Unknown selectionId: ${item.selectionId}.`));
      continue;
    }
    entries.push({ ...selection, selectionId: item.selectionId, slot: item.slot as LineupEntry["slot"] });
  }

  const duplicatePlayers = entries
    .map((entry) => entry.player_id)
    .filter((playerId, index, all) => all.indexOf(playerId) !== index);
  if (duplicatePlayers.length > 0) {
    errors.push(error("DUPLICATE_SELECTION", "A player may appear only once."));
  }

  for (const item of entries) {
    if (!SLOTS.includes(item.slot)) {
      errors.push(error("INVALID_SLOT", `${item.slot} is not a valid roster slot.`));
      continue;
    }
    if (!item.eligible_slots.includes(item.slot)) {
      errors.push(error("INVALID_SLOT", `${item.name} is not eligible for ${item.slot}.`));
    }
  }

  for (const rule of roster) {
    const actual = parsed.lineup.filter((item) => item.slot === rule.slot).length;
    if (actual !== rule.count) {
      errors.push(error("SLOT_COUNT", `${rule.slot} requires ${rule.count}; received ${actual}.`));
    }
  }

  const totalCost = entries.reduce((sum, entry) => sum + entry.price, 0);
  if (totalCost > SALARY_CAP) {
    errors.push(error("SALARY_CAP_EXCEEDED", `Lineup costs $${totalCost}; maximum is $${SALARY_CAP}.`));
  }

  return { errors, totalCost, entries };
}

function acceptedBody(run: RunRecord, lineup: AcceptedLineup, message = "Lineup accepted.") {
  return {
    message,
    accepted: true,
    runId: run.id,
    submittedAt: lineup.accepted_at,
    totalCost: lineup.total_cost,
    lineupHash: lineup.lineup_hash,
  };
}

export async function submitLineup(input: {
  db: Database;
  routeRunId: string;
  teamId: string;
  rawBody: string;
  receivedAt: string;
  transport: string;
}): Promise<SubmissionResult> {
  const payloadHash = await sha256(input.rawBody);
  const run = await one<RunRecord>(
    input.db,
    "SELECT * FROM runs WHERE id = $1 AND team_id = $2",
    [input.routeRunId, input.teamId],
  );
  if (!run) {
    const message = "Run not found.";
    return { status: 404, body: { message, error: { code: "RUN_NOT_FOUND", message } } };
  }

  const challenge = await one<ChallengeRecord>(
    input.db,
    "SELECT * FROM challenges WHERE id = $1",
    [run.challenge_id],
  );
  if (!challenge) {
    const message = "Run not found.";
    return { status: 404, body: { message, error: { code: "RUN_NOT_FOUND", message } } };
  }

  if (Date.parse(input.receivedAt) >= Date.parse(run.deadline_at)) {
    await recordAttempt(input.db, run.id, input.receivedAt, input.transport, payloadHash, "late", []);
    await appendAuditEvent(input.db, run.id, "submission.late", { payloadHash, deadlineAt: run.deadline_at });
    const message = "The submission deadline has passed.";
    return { status: 410, body: { message, error: { code: "CHALLENGE_CLOSED", message } } };
  }

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    body = undefined;
  }
  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) {
    const errors = [error("SCHEMA_INVALID", "Submission does not match the required schema.")];
    await recordAttempt(input.db, run.id, input.receivedAt, input.transport, payloadHash, "invalid", errors);
    await appendAuditEvent(input.db, run.id, "submission.invalid", { payloadHash, errors });
    return {
      status: 422,
      body: { message: "Lineup validation failed.", accepted: false, deadlineAt: run.deadline_at, errors },
    };
  }

  const selections = await input.db.query<SelectionRecord>(
    "SELECT * FROM selections WHERE challenge_id = $1",
    [run.challenge_id],
  );
  const validation = validateLineup(parsed.data, input.routeRunId, run, selections.rows, challenge.packet.roster);
  const canonicalEntries = validation.entries
    .map((entry) => ({ selectionId: entry.selectionId, slot: entry.slot }))
    .sort((left, right) => left.slot.localeCompare(right.slot) || left.selectionId.localeCompare(right.selectionId));
  const lineupHash = await sha256(stableStringify(canonicalEntries));

  const existing = await one<AcceptedLineup>(
    input.db,
    "SELECT id, lineup_hash, total_cost, accepted_at FROM lineups WHERE run_id = $1",
    [run.id],
  );
  if (existing) {
    const status = existing.lineup_hash === lineupHash ? "idempotent" : "conflict";
    await recordAttempt(input.db, run.id, input.receivedAt, input.transport, payloadHash, status, []);
    await appendAuditEvent(input.db, run.id, `submission.${status}`, { payloadHash, lineupHash });
    if (status === "idempotent") {
      return { status: 200, body: acceptedBody(run, existing, "This lineup was already accepted.") };
    }
    const message = "This run already has an accepted lineup.";
    return {
      status: 409,
      body: { message, error: { code: "LINEUP_ALREADY_ACCEPTED", message } },
    };
  }

  if (validation.errors.length > 0) {
    await transaction(input.db, async (client) => {
      await client.query(
        `INSERT INTO attempts
          (id, run_id, received_at, transport, payload_hash, status, validation_errors)
         VALUES ($1, $2, $3, $4, $5, 'invalid', $6)`,
        [
          randomId("attempt"), run.id, input.receivedAt, input.transport, payloadHash,
          validation.errors,
        ],
      );
      await client.query(
        "UPDATE runs SET status = 'invalid' WHERE id = $1 AND status != 'accepted'",
        [run.id],
      );
    });
    await appendAuditEvent(input.db, run.id, "submission.invalid", {
      payloadHash,
      errors: validation.errors,
    });
    return {
      status: 422,
      body: {
        message: "Lineup validation failed.",
        accepted: false,
        deadlineAt: run.deadline_at,
        errors: validation.errors,
      },
    };
  }

  const lineupId = `lineup_${run.id}`;
  await transaction(input.db, async (client) => {
    await client.query(
      `INSERT INTO lineups
        (id, run_id, team_id, challenge_id, season, week, total_cost, lineup_hash, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [
        lineupId,
        run.id,
        run.team_id,
        challenge.id,
        challenge.season,
        challenge.week,
        validation.totalCost,
        lineupHash,
        input.receivedAt,
      ],
    );

    for (const entry of validation.entries) {
      await client.query(
        `INSERT INTO lineup_players (lineup_id, selection_id, player_id, slot)
         SELECT $1, $2, $3, $4 WHERE EXISTS (
           SELECT 1 FROM lineups WHERE id = $5 AND lineup_hash = $6
         ) ON CONFLICT DO NOTHING`,
        [lineupId, entry.selectionId, entry.player_id, entry.slot, lineupId, lineupHash],
      );
    }
    await client.query(
      `UPDATE runs SET status = 'accepted', accepted_at = $1, accepted_lineup_hash = $2
       WHERE id = $3 AND accepted_lineup_hash IS NULL`,
      [input.receivedAt, lineupHash, run.id],
    );
  });

  const accepted = await one<AcceptedLineup>(
    input.db,
    "SELECT id, lineup_hash, total_cost, accepted_at FROM lineups WHERE run_id = $1",
    [run.id],
  );
  if (!accepted || accepted.lineup_hash !== lineupHash) {
    await recordAttempt(input.db, run.id, input.receivedAt, input.transport, payloadHash, "conflict", []);
    await appendAuditEvent(input.db, run.id, "submission.conflict", { payloadHash, lineupHash });
    const message = "This run already has an accepted lineup.";
    return {
      status: 409,
      body: { message, error: { code: "LINEUP_ALREADY_ACCEPTED", message } },
    };
  }

  await recordAttempt(input.db, run.id, input.receivedAt, input.transport, payloadHash, "accepted", []);
  await appendAuditEvent(input.db, run.id, "submission.accepted", {
    payloadHash,
    lineupHash,
    totalCost: validation.totalCost,
    transport: input.transport,
  });

  return { status: 200, body: acceptedBody(run, accepted) };
}
