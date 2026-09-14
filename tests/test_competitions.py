from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service


def test_create_and_list_competition(bootstrapped_db: Database) -> None:
    competition = competitions_service.create_competition(
        bootstrapped_db, name="Championnat Test", event_date="2026-10-15", judge_count=3
    )

    assert competition["name"] == "Championnat Test"
    assert competition["season"] == "2026/2027"
    assert competition["judgeCount"] == 3
    assert competition["status"] == "draft"
    assert competition["hasDeletionPassword"] in (0, False)
    # Une version active de chaque grille doit avoir ete attribuee (Phase 1/2).
    assert competition["artisticSoloGridVersionId"]

    listed = competitions_service.list_competitions(bootstrapped_db)
    assert any(item["id"] == competition["id"] for item in listed)


def test_create_competition_rejects_duplicate_name_and_date(bootstrapped_db: Database) -> None:
    competitions_service.create_competition(bootstrapped_db, name="Doublon", event_date="2026-05-01")

    with pytest.raises(ValueError):
        competitions_service.create_competition(bootstrapped_db, name="doublon", event_date="2026-05-01")


def test_update_competition_requires_existing(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        competitions_service.update_competition(bootstrapped_db, competition_id="missing", name="X")


def test_only_one_active_competition_allowed(bootstrapped_db: Database) -> None:
    first = competitions_service.create_competition(bootstrapped_db, name="Comp 1", event_date="2026-01-01")
    second = competitions_service.create_competition(bootstrapped_db, name="Comp 2", event_date="2026-02-01")

    competitions_service.update_competition(
        bootstrapped_db, competition_id=first["id"], name=first["name"], event_date=first["eventDate"], status="active"
    )

    with pytest.raises(ValueError):
        competitions_service.update_competition(
            bootstrapped_db,
            competition_id=second["id"],
            name=second["name"],
            event_date=second["eventDate"],
            status="active",
        )


def test_delete_competition(bootstrapped_db: Database) -> None:
    competition = competitions_service.create_competition(bootstrapped_db, name="A supprimer", event_date="2026-03-01")
    result = competitions_service.delete_competition(bootstrapped_db, competition["id"])

    assert result == {"deletedCompetitionId": competition["id"]}
    assert competitions_service.get_competition_row_by_id(bootstrapped_db, competition["id"]) is None


def test_regional_competition_requires_region(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        competitions_service.create_competition(
            bootstrapped_db, name="Regionale", event_date="2026-04-01", competition_level="regional"
        )

    competition = competitions_service.create_competition(
        bootstrapped_db,
        name="Regionale Sud-Est",
        event_date="2026-04-02",
        competition_level="regional",
        region="Sud-Est",
    )
    assert competition["region"] == "Sud-Est"
    assert competition["zone"] == "Sud"


def test_normalize_judge_count_clamps() -> None:
    assert competitions_service.normalize_judge_count(0) == 1
    assert competitions_service.normalize_judge_count(20) == 9
    assert competitions_service.normalize_judge_count("abc") == 3
    assert competitions_service.normalize_judge_count(5) == 5


def test_list_competitions_on_real_reference_data(reference_db: Database) -> None:
    listed = competitions_service.list_competitions(reference_db)
    assert len(listed) > 0
    for competition in listed:
        assert "hasGeneralInfo" in competition
        assert "hasResults" in competition
