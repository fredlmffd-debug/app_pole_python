from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import judge_assignments as judge_assignments_service
from pole_scoring.services import judges as judges_service


@pytest.fixture
def competition_and_judge(bootstrapped_db: Database) -> dict:
    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp Assignations", event_date="2026-09-05", judge_count=3
    )
    judge = judges_service.add_judge(
        bootstrapped_db, first_name="Alice", last_name="Martin", login="alice", password="secret"
    )
    return {"competition": competition, "judge": judge}


def test_get_judge_assignments_returns_empty_slots(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    assignments = judge_assignments_service.get_competition_judge_assignments(
        bootstrapped_db, competition_and_judge["competition"]["id"]
    )
    assert len(assignments) == 3
    assert all(item["judgeId"] == "" for item in assignments)


def test_set_and_clear_judge_assignment(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    competition_id = competition_and_judge["competition"]["id"]
    judge_id = competition_and_judge["judge"]["id"]

    assignments = judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db, competition_id=competition_id, slot_index=1, judge_role="head", judge_id=judge_id
    )
    assert assignments[0]["judgeId"] == judge_id
    assert assignments[0]["judgeRole"] == "head"

    cleared = judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db, competition_id=competition_id, slot_index=1, judge_role="", judge_id="", is_trainee=False
    )
    assert cleared[0]["judgeId"] == ""


def test_set_judge_assignment_rejects_double_booking(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    competition_id = competition_and_judge["competition"]["id"]
    judge_id = competition_and_judge["judge"]["id"]

    judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db, competition_id=competition_id, slot_index=1, judge_role="head", judge_id=judge_id
    )

    with pytest.raises(ValueError):
        judge_assignments_service.set_competition_judge_assignment(
            bootstrapped_db, competition_id=competition_id, slot_index=2, judge_role="artistique", judge_id=judge_id
        )


def test_set_judge_assignment_rejects_out_of_range_slot(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    with pytest.raises(ValueError):
        judge_assignments_service.set_competition_judge_assignment(
            bootstrapped_db,
            competition_id=competition_and_judge["competition"]["id"],
            slot_index=99,
            judge_role="head",
            judge_id=competition_and_judge["judge"]["id"],
        )


def test_judge_presence_and_access_state(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    competition_id = competition_and_judge["competition"]["id"]
    judge_id = competition_and_judge["judge"]["id"]

    judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db, competition_id=competition_id, slot_index=1, judge_role="head", judge_id=judge_id
    )

    access_state = judge_assignments_service.get_judge_access_state(
        bootstrapped_db, competition_id=competition_id, judge_id=judge_id
    )
    assert access_state["isAuthorized"] is True
    assert access_state["judgeRole"] == "head"

    presence = judge_assignments_service.get_competition_judge_presence(bootstrapped_db, competition_id)
    assert len(presence["judges"]) == 1
    assert presence["judges"][0]["isConnected"] is True


def test_authenticate_judge_wrong_password(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    with pytest.raises(ValueError):
        judge_assignments_service.authenticate_judge(
            bootstrapped_db,
            competition_id=competition_and_judge["competition"]["id"],
            login="alice",
            password="wrong",
        )


def test_authenticate_judge_success(bootstrapped_db: Database, competition_and_judge: dict) -> None:
    result = judge_assignments_service.authenticate_judge(
        bootstrapped_db, competition_id=competition_and_judge["competition"]["id"], login="alice", password="secret"
    )
    assert result["judge"]["login"] == "alice"
