CREATE TABLE selection_scores (
  challenge_id TEXT NOT NULL,
  selection_id TEXT NOT NULL,
  points DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (challenge_id, selection_id),
  FOREIGN KEY (challenge_id, selection_id)
    REFERENCES selections(challenge_id, selection_id) ON DELETE CASCADE
);
