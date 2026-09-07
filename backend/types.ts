import type { Database } from "./db/postgres";
import type { ChallengePacket, ValidationError } from "../src/shared/contracts";

export interface Env {
  DB: Database;
  APP_BASE_URL: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ADMIN_SECRET?: string;
  CURRENT_SEASON: string;
  SEASON_START_AT: string;
  SEASON_END_AT: string;
  FANTASYNERDS_API_KEY?: string;
  FANTASYNERDS_BASE_URL?: string;
  FANTASYNERDS_OPERATOR?: string;
  USE_FIXTURES: string;
}

export type AppVariables = {
  team: TeamRecord;
};

export interface TeamRecord {
  id: string;
  team_name: string;
  x_handle: string | null;
  email: string;
  api_key_hash: string;
  email_verified_at?: string | null;
  created_at: string;
}

export interface ChallengeRecord {
  id: string;
  season: number;
  week: number;
  status: "ready" | "open" | "closed" | "final";
  protocol_version: string;
  released_at: string;
  deadline_at: string;
  first_game_at: string;
  salary_cap: number;
  packet: ChallengePacket;
  content_hash: string;
  generated_at: string;
}

export interface AttemptRecord {
  status: string;
  validation_errors: ValidationError[];
  received_at: string;
}

export interface RunRecord {
  id: string;
  challenge_id: string;
  team_id: string;
  nonce: string;
  deadline_at: string;
  status: "delivered" | "invalid" | "accepted" | "expired";
  first_delivered_at: string;
  accepted_at: string | null;
  accepted_lineup_hash: string | null;
}
