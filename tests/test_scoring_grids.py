from __future__ import annotations

from pole_scoring.db.connection import Database
from pole_scoring.services import scoring_grids


def test_ensure_default_scoring_grids_creates_four_active_versions(db: Database) -> None:
    scoring_grids.ensure_default_scoring_grids(db)

    profile = scoring_grids.get_scoring_profile_version_ids(db)
    assert all(profile.values())

    for grid_key in scoring_grids.SCORING_GRID_KEYS:
        version = scoring_grids.get_active_scoring_grid_version(db, grid_key)
        assert version is not None
        assert version["isActive"] == 1

    criteria_count = db.query_one("SELECT COUNT(*) AS count FROM scoring_grid_criteria")["count"]
    assert criteria_count == 24  # 4 grilles x 6 criteres


def test_ensure_default_scoring_grids_is_idempotent(db: Database) -> None:
    scoring_grids.ensure_default_scoring_grids(db)
    scoring_grids.ensure_default_scoring_grids(db)

    grids_count = db.query_one("SELECT COUNT(*) AS count FROM scoring_grids")["count"]
    versions_count = db.query_one("SELECT COUNT(*) AS count FROM scoring_grid_versions")["count"]
    assert grids_count == 4
    assert versions_count == 4


def test_build_criterion_key_format() -> None:
    assert scoring_grids.build_criterion_key("artistic_solo", 1, 1) == "AS1_v1"
    assert scoring_grids.build_criterion_key("technical_duo", 3, 2) == "TD3_v2"
