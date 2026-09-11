from __future__ import annotations

from pole_scoring.db.connection import Database

EXPECTED_TABLES = {
    "settings",
    "competitions",
    "competitors",
    "athletes",
    "competitor_members",
    "judges",
    "access_accounts",
    "access_sessions",
    "access_recovery_codes",
    "scores",
    "scoring_grids",
    "scoring_grid_versions",
    "scoring_grid_criteria",
    "judge_competition_authorizations",
    "judge_competition_assignments",
    "judge_presence",
    "sync_events",
    "competitor_score_summaries",
}

EXPECTED_TRIGGERS = {
    "trg_scores_refresh_summary_insert",
    "trg_scores_refresh_summary_update",
    "trg_scores_refresh_summary_delete",
}


def test_schema_creates_all_tables(db: Database) -> None:
    rows = db.query_all("SELECT name FROM sqlite_master WHERE type = 'table'")
    table_names = {row["name"] for row in rows}
    assert EXPECTED_TABLES.issubset(table_names)


def test_schema_creates_view_and_triggers(db: Database) -> None:
    view_row = db.query_one(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'competition_competitor_score_metrics'"
    )
    assert view_row is not None

    rows = db.query_all("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    trigger_names = {row["name"] for row in rows}
    assert EXPECTED_TRIGGERS.issubset(trigger_names)


def test_schema_init_is_idempotent(tmp_path) -> None:
    db_file = tmp_path / "pole-scoring.sqlite"
    first = Database(db_file)
    first.close()

    # Reouvrir sur le meme fichier ne doit pas lever d'erreur (ALTER TABLE
    # deja appliques, index/vues/triggers deja crees).
    second = Database(db_file)
    rows = second.query_all("SELECT name FROM sqlite_master WHERE type = 'table'")
    assert EXPECTED_TABLES.issubset({row["name"] for row in rows})
    second.close()
