from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
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


def test_create_scoring_grid_version_deactivates_previous(bootstrapped_db: Database) -> None:
    result = scoring_grids.create_scoring_grid_version(
        bootstrapped_db, grid_key="artistic_solo", criteria=["Critère unique"], activate=True
    )

    assert result["version"]["versionNumber"] == 2
    assert result["version"]["isActive"] is True
    assert len(result["version"]["criteria"]) == 1

    active_version = scoring_grids.get_active_scoring_grid_version(bootstrapped_db, "artistic_solo")
    assert active_version["id"] == result["version"]["id"]

    grids = scoring_grids.list_scoring_grids(bootstrapped_db)
    artistic_solo = next(grid for grid in grids if grid["gridKey"] == "artistic_solo")
    assert len(artistic_solo["versions"]) == 2


def test_create_scoring_grid_version_rejects_invalid_range(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        scoring_grids.create_scoring_grid_version(
            bootstrapped_db, grid_key="artistic_solo", criteria=["X"], score_min=5, score_max=0
        )


def test_set_active_scoring_grid_version(bootstrapped_db: Database) -> None:
    created = scoring_grids.create_scoring_grid_version(
        bootstrapped_db, grid_key="artistic_solo", criteria=["Nouveau critère"], activate=False
    )
    assert created["version"]["isActive"] is False

    result = scoring_grids.set_active_scoring_grid_version(
        bootstrapped_db, grid_key="artistic_solo", version_id=created["version"]["id"]
    )
    assert result["activeVersionId"] == created["version"]["id"]

    active_version = scoring_grids.get_active_scoring_grid_version(bootstrapped_db, "artistic_solo")
    assert active_version["id"] == created["version"]["id"]


def test_create_and_revise_scoring_criterion(bootstrapped_db: Database) -> None:
    before = scoring_grids.get_active_scoring_grid_version(bootstrapped_db, "artistic_solo")
    before_criteria = scoring_grids.list_scoring_criteria_by_version(bootstrapped_db, before["id"])

    scoring_grids.create_scoring_criterion(bootstrapped_db, grid_key="artistic_solo", label="Nouveau critère")

    after = scoring_grids.get_active_scoring_grid_version(bootstrapped_db, "artistic_solo")
    after_criteria = scoring_grids.list_scoring_criteria_by_version(bootstrapped_db, after["id"])
    assert len(after_criteria) == len(before_criteria) + 1

    target = after_criteria[0]
    scoring_grids.revise_scoring_criterion(bootstrapped_db, criterion_id=target["id"], label="Libellé révisé")

    latest = scoring_grids.get_active_scoring_grid_version(bootstrapped_db, "artistic_solo")
    latest_criteria = scoring_grids.list_scoring_criteria_by_version(bootstrapped_db, latest["id"])
    assert any(criterion["label"] == "Libellé révisé" for criterion in latest_criteria)


def test_list_scoring_criteria_catalog(bootstrapped_db: Database) -> None:
    catalog = scoring_grids.list_scoring_criteria_catalog(bootstrapped_db)
    assert len(catalog) == 24
    assert all(entry["isEnabled"] is True for entry in catalog)


def test_get_competition_scoring_profile(bootstrapped_db: Database) -> None:
    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp Profil", event_date="2026-09-03"
    )
    profile = scoring_grids.get_competition_scoring_profile(bootstrapped_db, competition["id"])

    assert profile["competitionId"] == competition["id"]
    assert profile["profile"]["artisticSolo"] is not None
    assert len(profile["profile"]["artisticSolo"]["criteria"]) == 6


def test_get_competition_scoring_profile_missing_competition(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        scoring_grids.get_competition_scoring_profile(bootstrapped_db, "missing")
