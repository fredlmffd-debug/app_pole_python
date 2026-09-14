from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import judges as judges_service


def test_add_and_list_judge(db: Database) -> None:
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")

    assert judge["name"] == "Alice Martin"
    assert judge["login"] == "alice"
    assert judge["isActive"] == 1

    listed = judges_service.list_judges(db)
    assert len(listed) == 1


def test_add_judge_rejects_duplicate_login(db: Database) -> None:
    judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")

    with pytest.raises(ValueError):
        judges_service.add_judge(db, first_name="Bob", last_name="Durand", login="alice", password="secret2")


def test_update_judge_keeps_password_when_not_provided(db: Database) -> None:
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    updated = judges_service.update_judge(
        db, judge_id=judge["id"], first_name="Alice", last_name="Martin-Dupont", login="alice", password=""
    )

    assert updated["lastName"] == "Martin-Dupont"


def test_update_judge_activity_toggle(db: Database) -> None:
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    deactivated = judges_service.update_judge_activity(db, judge_id=judge["id"], is_active=False)
    assert deactivated["isActive"] == 0

    reactivated = judges_service.update_judge_activity(db, judge_id=judge["id"], is_active=True)
    assert reactivated["isActive"] == 1


def test_delete_judge(db: Database) -> None:
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    result = judges_service.delete_judge(db, judge["id"])

    assert result == {"deletedJudgeId": judge["id"]}
    assert judges_service.get_judge_by_id(db, judge["id"]) is None


def test_delete_judge_blocked_when_scores_exist(db: Database) -> None:
    from pole_scoring.utils.time import now

    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    db.execute(
        "INSERT INTO competitions (id, name, status, created_at, updated_at) VALUES ('c1', 'Comp', 'draft', ?, ?)",
        (now(), now()),
    )
    db.execute(
        """
        INSERT INTO competitors (id, competition_id, stage_name, running_order, created_at, updated_at)
        VALUES ('cp1', 'c1', 'Danseuse', 1, ?, ?)
        """,
        (now(), now()),
    )
    db.execute(
        """
        INSERT INTO scores (id, competition_id, competitor_id, judge_id, criterion, score, source_node_id, created_at, updated_at)
        VALUES ('s1', 'c1', 'cp1', ?, 'artistic:1', 4.5, 'node', ?, ?)
        """,
        (judge["id"], now(), now()),
    )

    with pytest.raises(ValueError):
        judges_service.delete_judge(db, judge["id"])


def test_clear_judge_presence(db: Database) -> None:
    from pole_scoring.utils.time import now

    db.execute(
        "INSERT INTO competitions (id, name, status, created_at, updated_at) VALUES ('c1', 'Comp', 'draft', ?, ?)",
        (now(), now()),
    )
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    db.execute(
        "INSERT INTO judge_presence (competition_id, judge_id, last_seen_at) VALUES ('c1', ?, ?)",
        (judge["id"], now()),
    )

    result = judges_service.clear_judge_presence(db, competition_id="c1", judge_id=judge["id"])
    assert result["cleared"] is True
    assert db.query_one("SELECT * FROM judge_presence WHERE judge_id = ?", (judge["id"],)) is None


def test_list_judges_on_real_reference_data(reference_db: Database) -> None:
    listed = judges_service.list_judges(reference_db)
    assert len(listed) > 0
