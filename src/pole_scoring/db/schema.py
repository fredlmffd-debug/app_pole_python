"""Schema SQLite du portage Python.

Porte a l'identique depuis app_pole/src/db.js (memes noms de tables/colonnes,
meme vue de calcul des scores, memes triggers) : le fichier .sqlite reste
interchangeable entre la version Node et cette version Python.
"""

from __future__ import annotations

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT,
  event_date TEXT,
  season TEXT,
  competition_level TEXT,
  region TEXT,
  zone TEXT,
  judge_count INTEGER NOT NULL DEFAULT 3,
  scrutateur_name TEXT,
  delete_password_hash TEXT,
  artistic_solo_grid_version_id TEXT,
  artistic_duo_grid_version_id TEXT,
  technical_solo_grid_version_id TEXT,
  technical_duo_grid_version_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  category TEXT,
  running_order INTEGER NOT NULL,
  is_resident INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS athletes (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT NOT NULL DEFAULT '',
  identity_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_members (
  competitor_id TEXT NOT NULL,
  athlete_id TEXT NOT NULL,
  member_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competitor_id, member_order),
  UNIQUE (competitor_id, athlete_id),
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE,
  FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS judges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  device_label TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_accounts (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_sessions (
  id TEXT PRIMARY KEY,
  access_account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  FOREIGN KEY (access_account_id) REFERENCES access_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_recovery_codes (
  id TEXT PRIMARY KEY,
  access_account_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_value TEXT,
  code_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  used_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (access_account_id) REFERENCES access_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  competition_id TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  score REAL NOT NULL,
  comment TEXT,
  source_node_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE,
  FOREIGN KEY (judge_id) REFERENCES judges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scoring_grids (
  id TEXT PRIMARY KEY,
  grid_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  sector TEXT NOT NULL,
  division TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scoring_grid_versions (
  id TEXT PRIMARY KEY,
  grid_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  score_min REAL NOT NULL DEFAULT 0,
  score_max REAL NOT NULL DEFAULT 5,
  score_step REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (grid_id, version_number),
  FOREIGN KEY (grid_id) REFERENCES scoring_grids(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scoring_grid_criteria (
  id TEXT PRIMARY KEY,
  grid_version_id TEXT NOT NULL,
  criterion_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (grid_version_id, criterion_key),
  UNIQUE (grid_version_id, sort_order),
  FOREIGN KEY (grid_version_id) REFERENCES scoring_grid_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS judge_competition_authorizations (
  competition_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  is_authorized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, judge_id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (judge_id) REFERENCES judges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS judge_competition_assignments (
  competition_id TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  judge_role TEXT NOT NULL DEFAULT '',
  judge_id TEXT,
  is_trainee INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, slot_index),
  UNIQUE (competition_id, judge_id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (judge_id) REFERENCES judges(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS judge_presence (
  competition_id TEXT NOT NULL,
  judge_id TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, judge_id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (judge_id) REFERENCES judges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_node_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS competitor_score_summaries (
  competition_id TEXT NOT NULL,
  competitor_id TEXT NOT NULL,
  artistic_score REAL NOT NULL DEFAULT 0,
  technical_score REAL NOT NULL DEFAULT 0,
  penalty_total REAL NOT NULL DEFAULT 0,
  final_score REAL,
  score_count INTEGER NOT NULL DEFAULT 0,
  required_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (competition_id, competitor_id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
);
"""

# Chaque ALTER TABLE est execute individuellement et son echec ignore (colonne
# deja presente sur une base existante) : identique au for/try/catch de db.js,
# necessaire car SQLite n'a pas de "ADD COLUMN IF NOT EXISTS".
ALTER_TABLE_STATEMENTS = [
    "ALTER TABLE competitions ADD COLUMN season TEXT",
    "ALTER TABLE competitions ADD COLUMN competition_level TEXT",
    "ALTER TABLE competitions ADD COLUMN region TEXT",
    "ALTER TABLE competitions ADD COLUMN zone TEXT",
    "ALTER TABLE competitions ADD COLUMN judge_count INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE competitions ADD COLUMN scrutateur_name TEXT",
    "ALTER TABLE competitions ADD COLUMN delete_password_hash TEXT",
    "ALTER TABLE competitions ADD COLUMN artistic_solo_grid_version_id TEXT",
    "ALTER TABLE competitions ADD COLUMN artistic_duo_grid_version_id TEXT",
    "ALTER TABLE competitions ADD COLUMN technical_solo_grid_version_id TEXT",
    "ALTER TABLE competitions ADD COLUMN technical_duo_grid_version_id TEXT",
    "ALTER TABLE judges ADD COLUMN first_name TEXT",
    "ALTER TABLE judges ADD COLUMN last_name TEXT",
    "ALTER TABLE judges ADD COLUMN login TEXT",
    "ALTER TABLE judges ADD COLUMN password_hash TEXT",
    "ALTER TABLE judges ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE judge_competition_assignments ADD COLUMN is_trainee INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE competitors ADD COLUMN first_name TEXT",
    "ALTER TABLE competitors ADD COLUMN last_name TEXT",
    "ALTER TABLE competitors ADD COLUMN is_resident INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE competitors ADD COLUMN status TEXT NOT NULL DEFAULT 'registered'",
    "ALTER TABLE access_accounts ADD COLUMN temp_password_hash TEXT",
    "ALTER TABLE access_accounts ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE access_recovery_codes ADD COLUMN code_value TEXT",
]

INDEXES_AND_MIGRATION_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_athletes_identity_key
ON athletes(identity_key)
WHERE identity_key <> '';

CREATE INDEX IF NOT EXISTS idx_competitor_members_competitor
ON competitor_members(competitor_id, member_order);

CREATE INDEX IF NOT EXISTS idx_competitor_members_athlete
ON competitor_members(athlete_id);

CREATE INDEX IF NOT EXISTS idx_scoring_grid_versions_grid
ON scoring_grid_versions(grid_id, version_number);

CREATE INDEX IF NOT EXISTS idx_scoring_grid_versions_active
ON scoring_grid_versions(grid_id, is_active);

CREATE INDEX IF NOT EXISTS idx_scoring_grid_criteria_version
ON scoring_grid_criteria(grid_version_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS idx_judges_login
ON judges(login)
WHERE login IS NOT NULL AND login <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_accounts_login
ON access_accounts(login);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_sessions_token
ON access_sessions(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_recovery_codes_hash
ON access_recovery_codes(code_hash);

CREATE INDEX IF NOT EXISTS idx_access_recovery_codes_account
ON access_recovery_codes(access_account_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_judge_competition_assignments_judge
ON judge_competition_assignments(competition_id, judge_id);

UPDATE judges
SET first_name = name
WHERE COALESCE(first_name, '') = '' AND COALESCE(name, '') <> '';

UPDATE judges
SET last_name = ''
WHERE last_name IS NULL;

UPDATE judges
SET login = ''
WHERE login IS NULL;

UPDATE judges
SET password_hash = ''
WHERE password_hash IS NULL;

UPDATE judges
SET is_active = 1
WHERE is_active IS NULL;

UPDATE competitors
SET first_name = ''
WHERE first_name IS NULL;

UPDATE competitors
SET last_name = COALESCE(NULLIF(last_name, ''), stage_name)
WHERE last_name IS NULL OR last_name = '';

UPDATE competitors
SET status = 'registered'
WHERE status IS NULL OR status = '';

UPDATE access_accounts
SET temp_password_hash = ''
WHERE temp_password_hash IS NULL;

UPDATE access_accounts
SET must_change_password = 0
WHERE must_change_password IS NULL;

UPDATE judge_competition_assignments
SET is_trainee = 0
WHERE is_trainee IS NULL;

INSERT INTO judge_competition_assignments (competition_id, slot_index, judge_role, judge_id, is_trainee, updated_at)
SELECT ranked.competition_id,
       ranked.slot_index,
       '',
       ranked.judge_id,
    0,
       ranked.updated_at
FROM (
  SELECT a.competition_id,
         a.judge_id,
         a.updated_at,
         ROW_NUMBER() OVER (PARTITION BY a.competition_id ORDER BY a.updated_at, a.judge_id) AS slot_index
  FROM judge_competition_authorizations a
  WHERE a.is_authorized = 1
) ranked
INNER JOIN competitions c
  ON c.id = ranked.competition_id
 AND ranked.slot_index <= COALESCE(c.judge_count, 3)
WHERE NOT EXISTS (
  SELECT 1
  FROM judge_competition_assignments existing
  WHERE existing.competition_id = ranked.competition_id
);
"""

VIEW_AND_TRIGGERS_SQL = """
DROP VIEW IF EXISTS competition_competitor_score_metrics;

CREATE VIEW competition_competitor_score_metrics AS
SELECT
  c.competition_id AS competitionId,
  c.id AS competitorId,
  COALESCE(ROUND(
    COALESCE((
      SELECT SUM(s.score)
      FROM scores s
      INNER JOIN judge_competition_assignments a
        ON a.competition_id = s.competition_id
       AND a.judge_id = s.judge_id
      WHERE s.competition_id = c.competition_id
        AND s.competitor_id = c.id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role = 'artistique'
        AND s.criterion LIKE 'artistic:%'
    ), 0) / NULLIF((
      SELECT COUNT(DISTINCT a.judge_id)
      FROM judge_competition_assignments a
      WHERE a.competition_id = c.competition_id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role = 'artistique'
        AND a.judge_id IS NOT NULL
    ), 0), 2
  ), 0) AS artisticScore,
  COALESCE(ROUND(
    COALESCE((
      SELECT SUM(s.score)
      FROM scores s
      INNER JOIN judge_competition_assignments a
        ON a.competition_id = s.competition_id
       AND a.judge_id = s.judge_id
      WHERE s.competition_id = c.competition_id
        AND s.competitor_id = c.id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role IN ('technique', 'head')
        AND s.criterion LIKE 'technical:%'
    ), 0) / NULLIF((
      SELECT COUNT(DISTINCT a.judge_id)
      FROM judge_competition_assignments a
      WHERE a.competition_id = c.competition_id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role IN ('technique', 'head')
        AND a.judge_id IS NOT NULL
    ), 0)
    - COALESCE((
      SELECT SUM(s.score)
      FROM scores s
      INNER JOIN judge_competition_assignments a
        ON a.competition_id = s.competition_id
       AND a.judge_id = s.judge_id
      WHERE s.competition_id = c.competition_id
        AND s.competitor_id = c.id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role = 'head'
        AND s.criterion LIKE 'penalty:%'
    ), 0), 2
  ), 0) AS technicalScore,
  COALESCE((
    SELECT SUM(s.score)
    FROM scores s
    INNER JOIN judge_competition_assignments a
      ON a.competition_id = s.competition_id
     AND a.judge_id = s.judge_id
    WHERE s.competition_id = c.competition_id
      AND s.competitor_id = c.id
      AND COALESCE(a.is_trainee, 0) = 0
      AND a.judge_role = 'head'
      AND s.criterion LIKE 'penalty:%'
  ), 0) AS penaltyTotal,
  CASE
    WHEN COALESCE((
      SELECT COUNT(*)
      FROM scores s
      INNER JOIN judge_competition_assignments a
        ON a.competition_id = s.competition_id
       AND a.judge_id = s.judge_id
      WHERE s.competition_id = c.competition_id
        AND s.competitor_id = c.id
        AND COALESCE(a.is_trainee, 0) = 0
        AND (
          (a.judge_role = 'artistique' AND s.criterion LIKE 'artistic:%')
          OR (a.judge_role IN ('technique', 'head') AND s.criterion LIKE 'technical:%')
        )
    ), 0) >= (
      COALESCE((
        SELECT COUNT(*)
        FROM scoring_grid_criteria gc
        WHERE gc.grid_version_id = CASE
          WHEN EXISTS(
            SELECT 1
            FROM competitor_members cm
            WHERE cm.competitor_id = c.id
              AND cm.member_order = 2
          )
          THEN comp.artistic_duo_grid_version_id
          ELSE comp.artistic_solo_grid_version_id
        END
        AND gc.is_enabled = 1
      ), 0) * COALESCE((
        SELECT COUNT(DISTINCT a.judge_id)
        FROM judge_competition_assignments a
        WHERE a.competition_id = c.competition_id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role = 'artistique'
          AND a.judge_id IS NOT NULL
      ), 0)
      +
      COALESCE((
        SELECT COUNT(*)
        FROM scoring_grid_criteria gc
        WHERE gc.grid_version_id = CASE
          WHEN EXISTS(
            SELECT 1
            FROM competitor_members cm
            WHERE cm.competitor_id = c.id
              AND cm.member_order = 2
          )
          THEN comp.technical_duo_grid_version_id
          ELSE comp.technical_solo_grid_version_id
        END
        AND gc.is_enabled = 1
      ), 0) * COALESCE((
        SELECT COUNT(DISTINCT a.judge_id)
        FROM judge_competition_assignments a
        WHERE a.competition_id = c.competition_id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role IN ('technique', 'head')
          AND a.judge_id IS NOT NULL
      ), 0)
    )
    THEN COALESCE(ROUND(
      COALESCE((
        SELECT SUM(s.score)
        FROM scores s
        INNER JOIN judge_competition_assignments a
          ON a.competition_id = s.competition_id
         AND a.judge_id = s.judge_id
        WHERE s.competition_id = c.competition_id
          AND s.competitor_id = c.id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role = 'artistique'
          AND s.criterion LIKE 'artistic:%'
      ), 0) / NULLIF((
        SELECT COUNT(DISTINCT a.judge_id)
        FROM judge_competition_assignments a
        WHERE a.competition_id = c.competition_id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role = 'artistique'
          AND a.judge_id IS NOT NULL
      ), 0), 2
    ), 0) + COALESCE(ROUND(
      COALESCE((
        SELECT SUM(s.score)
        FROM scores s
        INNER JOIN judge_competition_assignments a
          ON a.competition_id = s.competition_id
         AND a.judge_id = s.judge_id
        WHERE s.competition_id = c.competition_id
          AND s.competitor_id = c.id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role IN ('technique', 'head')
          AND s.criterion LIKE 'technical:%'
      ), 0) / NULLIF((
        SELECT COUNT(DISTINCT a.judge_id)
        FROM judge_competition_assignments a
        WHERE a.competition_id = c.competition_id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role IN ('technique', 'head')
          AND a.judge_id IS NOT NULL
      ), 0)
      - COALESCE((
        SELECT SUM(s.score)
        FROM scores s
        INNER JOIN judge_competition_assignments a
          ON a.competition_id = s.competition_id
         AND a.judge_id = s.judge_id
        WHERE s.competition_id = c.competition_id
          AND s.competitor_id = c.id
          AND COALESCE(a.is_trainee, 0) = 0
          AND a.judge_role = 'head'
          AND s.criterion LIKE 'penalty:%'
      ), 0), 2
    ), 0)
    ELSE NULL
  END AS finalScore,
  COALESCE((
    SELECT COUNT(*)
    FROM scores s
    INNER JOIN judge_competition_assignments a
      ON a.competition_id = s.competition_id
     AND a.judge_id = s.judge_id
    WHERE s.competition_id = c.competition_id
      AND s.competitor_id = c.id
      AND COALESCE(a.is_trainee, 0) = 0
      AND (
        (a.judge_role = 'artistique' AND s.criterion LIKE 'artistic:%')
        OR (a.judge_role IN ('technique', 'head') AND s.criterion LIKE 'technical:%')
      )
  ), 0) AS scoreCount,
  (
    COALESCE((
      SELECT COUNT(*)
      FROM scoring_grid_criteria gc
      WHERE gc.grid_version_id = CASE
        WHEN EXISTS(
          SELECT 1
          FROM competitor_members cm
          WHERE cm.competitor_id = c.id
            AND cm.member_order = 2
        )
        THEN comp.artistic_duo_grid_version_id
        ELSE comp.artistic_solo_grid_version_id
      END
      AND gc.is_enabled = 1
    ), 0) * COALESCE((
      SELECT COUNT(DISTINCT a.judge_id)
      FROM judge_competition_assignments a
      WHERE a.competition_id = c.competition_id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role = 'artistique'
        AND a.judge_id IS NOT NULL
    ), 0)
    +
    COALESCE((
      SELECT COUNT(*)
      FROM scoring_grid_criteria gc
      WHERE gc.grid_version_id = CASE
        WHEN EXISTS(
          SELECT 1
          FROM competitor_members cm
          WHERE cm.competitor_id = c.id
            AND cm.member_order = 2
        )
        THEN comp.technical_duo_grid_version_id
        ELSE comp.technical_solo_grid_version_id
      END
      AND gc.is_enabled = 1
    ), 0) * COALESCE((
      SELECT COUNT(DISTINCT a.judge_id)
      FROM judge_competition_assignments a
      WHERE a.competition_id = c.competition_id
        AND COALESCE(a.is_trainee, 0) = 0
        AND a.judge_role IN ('technique', 'head')
        AND a.judge_id IS NOT NULL
    ), 0)
  ) AS requiredCount
FROM competitors c
INNER JOIN competitions comp
  ON comp.id = c.competition_id;

DROP TRIGGER IF EXISTS trg_scores_refresh_summary_insert;
DROP TRIGGER IF EXISTS trg_scores_refresh_summary_update;
DROP TRIGGER IF EXISTS trg_scores_refresh_summary_delete;

CREATE TRIGGER trg_scores_refresh_summary_insert
AFTER INSERT ON scores
BEGIN
  INSERT INTO competitor_score_summaries (
    competition_id,
    competitor_id,
    artistic_score,
    technical_score,
    penalty_total,
    final_score,
    score_count,
    required_count,
    updated_at
  )
  SELECT
    competitionId,
    competitorId,
    artisticScore,
    technicalScore,
    penaltyTotal,
    finalScore,
    scoreCount,
    requiredCount,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM competition_competitor_score_metrics
  WHERE competitionId = NEW.competition_id
    AND competitorId = NEW.competitor_id
  ON CONFLICT(competition_id, competitor_id) DO UPDATE SET
    artistic_score = excluded.artistic_score,
    technical_score = excluded.technical_score,
    penalty_total = excluded.penalty_total,
    final_score = excluded.final_score,
    score_count = excluded.score_count,
    required_count = excluded.required_count,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_scores_refresh_summary_update
AFTER UPDATE ON scores
BEGIN
  INSERT INTO competitor_score_summaries (
    competition_id,
    competitor_id,
    artistic_score,
    technical_score,
    penalty_total,
    final_score,
    score_count,
    required_count,
    updated_at
  )
  SELECT
    competitionId,
    competitorId,
    artisticScore,
    technicalScore,
    penaltyTotal,
    finalScore,
    scoreCount,
    requiredCount,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM competition_competitor_score_metrics
  WHERE competitionId = NEW.competition_id
    AND competitorId = NEW.competitor_id
  ON CONFLICT(competition_id, competitor_id) DO UPDATE SET
    artistic_score = excluded.artistic_score,
    technical_score = excluded.technical_score,
    penalty_total = excluded.penalty_total,
    final_score = excluded.final_score,
    score_count = excluded.score_count,
    required_count = excluded.required_count,
    updated_at = excluded.updated_at;

  INSERT INTO competitor_score_summaries (
    competition_id,
    competitor_id,
    artistic_score,
    technical_score,
    penalty_total,
    final_score,
    score_count,
    required_count,
    updated_at
  )
  SELECT
    competitionId,
    competitorId,
    artisticScore,
    technicalScore,
    penaltyTotal,
    finalScore,
    scoreCount,
    requiredCount,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM competition_competitor_score_metrics
  WHERE competitionId = OLD.competition_id
    AND competitorId = OLD.competitor_id
  ON CONFLICT(competition_id, competitor_id) DO UPDATE SET
    artistic_score = excluded.artistic_score,
    technical_score = excluded.technical_score,
    penalty_total = excluded.penalty_total,
    final_score = excluded.final_score,
    score_count = excluded.score_count,
    required_count = excluded.required_count,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_scores_refresh_summary_delete
AFTER DELETE ON scores
BEGIN
  INSERT INTO competitor_score_summaries (
    competition_id,
    competitor_id,
    artistic_score,
    technical_score,
    penalty_total,
    final_score,
    score_count,
    required_count,
    updated_at
  )
  SELECT
    competitionId,
    competitorId,
    artisticScore,
    technicalScore,
    penaltyTotal,
    finalScore,
    scoreCount,
    requiredCount,
    STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM competition_competitor_score_metrics
  WHERE competitionId = OLD.competition_id
    AND competitorId = OLD.competitor_id
  ON CONFLICT(competition_id, competitor_id) DO UPDATE SET
    artistic_score = excluded.artistic_score,
    technical_score = excluded.technical_score,
    penalty_total = excluded.penalty_total,
    final_score = excluded.final_score,
    score_count = excluded.score_count,
    required_count = excluded.required_count,
    updated_at = excluded.updated_at;
END;
"""
