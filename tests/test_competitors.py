from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import competitors as competitors_service


@pytest.fixture
def competition(bootstrapped_db: Database) -> dict:
    return competitions_service.create_competition(bootstrapped_db, name="Comp Competiteurs", event_date="2026-06-01")


def test_add_solo_competitor(bootstrapped_db: Database, competition: dict) -> None:
    competitor = competitors_service.add_competitor(
        bootstrapped_db,
        competition_id=competition["id"],
        first_name="Jeanne",
        last_name="Dupont",
        running_order=1,
    )

    assert competitor["stage_name"] == "Dupont Jeanne"
    assert competitor["is_resident"] == 0
    assert len(competitor["members"]) == 0

    listed = competitors_service.list_competitors(bootstrapped_db, competition["id"])
    assert len(listed) == 1
    assert listed[0]["stageName"] == "Dupont Jeanne"


def test_add_duo_competitor_creates_members_and_shared_athletes(bootstrapped_db: Database, competition: dict) -> None:
    members = [
        {"firstName": "Alice", "lastName": "Martin", "birthDate": "1995-04-12", "memberOrder": 1},
        {"firstName": "Bob", "lastName": "Durand", "birthDate": "1993-09-03", "memberOrder": 2},
    ]

    competitor = competitors_service.add_competitor(
        bootstrapped_db,
        competition_id=competition["id"],
        members=members,
        running_order=1,
    )

    assert competitor["stage_name"] == "Martin Alice & Durand Bob"
    assert len(competitor["members"]) == 2

    stored_members = competitors_service.get_stored_competitor_members(bootstrapped_db, competitor["id"])
    assert len(stored_members) == 2

    # Reutiliser la meme identite (nom/prenom/naissance) doit reutiliser l'athlete existant.
    athletes_before = bootstrapped_db.query_all("SELECT id FROM athletes")

    second_competition = competitions_service.create_competition(
        bootstrapped_db, name="Autre Comp", event_date="2026-07-01"
    )
    competitors_service.add_competitor(
        bootstrapped_db,
        competition_id=second_competition["id"],
        members=[{"firstName": "Alice", "lastName": "Martin", "birthDate": "1995-04-12", "memberOrder": 1}],
        running_order=1,
    )

    athletes_after = bootstrapped_db.query_all("SELECT id FROM athletes")
    assert len(athletes_after) == len(athletes_before)


def test_duplicate_running_order_and_name_rejected(bootstrapped_db: Database, competition: dict) -> None:
    competitors_service.add_competitor(
        bootstrapped_db, competition_id=competition["id"], first_name="Jeanne", last_name="Dupont", running_order=1
    )

    with pytest.raises(ValueError):
        competitors_service.add_competitor(
            bootstrapped_db,
            competition_id=competition["id"],
            first_name="jeanne",
            last_name="dupont",
            running_order=1,
        )


def test_update_competitor_status(bootstrapped_db: Database, competition: dict) -> None:
    competitor = competitors_service.add_competitor(
        bootstrapped_db, competition_id=competition["id"], first_name="Jeanne", last_name="Dupont", running_order=1
    )

    updated = competitors_service.update_competitor_status(
        bootstrapped_db, competitor_id=competitor["id"], status="withdrawn"
    )

    assert updated["status"] == "withdrawn"


def test_replace_competition_competitors_only_for_draft(bootstrapped_db: Database, competition: dict) -> None:
    competitors_service.add_competitor(
        bootstrapped_db, competition_id=competition["id"], first_name="Jeanne", last_name="Dupont", running_order=1
    )

    result = competitors_service.replace_competition_competitors(bootstrapped_db, competition["id"])
    assert result == {"deletedCompetitorCount": 1}
    assert competitors_service.list_competitors(bootstrapped_db, competition["id"]) == []

    competitions_service.update_competition(
        bootstrapped_db,
        competition_id=competition["id"],
        name=competition["name"],
        event_date=competition["eventDate"],
        status="active",
    )

    with pytest.raises(ValueError):
        competitors_service.replace_competition_competitors(bootstrapped_db, competition["id"])


def test_parse_resident_flag_accepts_various_inputs() -> None:
    assert competitors_service.parse_resident_flag(True) is True
    assert competitors_service.parse_resident_flag("1") is True
    assert competitors_service.parse_resident_flag("Résident") is True
    assert competitors_service.parse_resident_flag("oui") is True
    assert competitors_service.parse_resident_flag("non") is False
    assert competitors_service.parse_resident_flag(None) is False


def test_list_competitors_on_real_reference_data(reference_db: Database) -> None:
    competitions = competitions_service.list_competitions(reference_db)
    assert competitions

    total_competitors = 0
    for competition in competitions:
        competitors = competitors_service.list_competitors(reference_db, competition["id"])
        total_competitors += len(competitors)

    assert total_competitors > 0
