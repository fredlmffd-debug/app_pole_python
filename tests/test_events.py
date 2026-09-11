from __future__ import annotations

import json

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.db.events import delete_entity, record_event
from pole_scoring.utils.time import now


def test_record_event_inserts_sync_event(db: Database) -> None:
    payload = {"id": "abc", "name": "Test", "updated_at": now()}
    event = record_event(db, "judge", "abc", "upsert", payload, "node-1")

    stored = db.query_one("SELECT * FROM sync_events WHERE id = ?", (event["id"],))
    assert stored is not None
    assert stored["entity_type"] == "judge"
    assert stored["entity_id"] == "abc"
    assert stored["operation"] == "upsert"
    assert stored["source_node_id"] == "node-1"
    assert json.loads(stored["payload"]) == payload


def test_record_event_falls_back_to_now_when_payload_has_no_timestamp(db: Database) -> None:
    event = record_event(db, "judge", "abc", "delete", {}, "node-1")
    assert event["occurred_at"]


def test_delete_entity_removes_row_from_mapped_table(db: Database) -> None:
    db.execute(
        "INSERT INTO judges (id, name, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        ("judge-1", "Alice", "juge", now(), now()),
    )

    delete_entity(db, "judge", "judge-1")

    assert db.query_one("SELECT id FROM judges WHERE id = ?", ("judge-1",)) is None


def test_delete_entity_rejects_unknown_type(db: Database) -> None:
    with pytest.raises(ValueError):
        delete_entity(db, "unknown", "x")


def test_delete_entity_parses_competition_judge_assignment_id(db: Database) -> None:
    db.execute(
        """
        INSERT INTO competitions (id, name, status, created_at, updated_at)
        VALUES ('comp-1', 'Test', 'draft', ?, ?)
        """,
        (now(), now()),
    )
    db.execute(
        """
        INSERT INTO judge_competition_assignments (competition_id, slot_index, judge_role, judge_id, updated_at)
        VALUES ('comp-1', 1, 'head', NULL, ?)
        """,
        (now(),),
    )

    delete_entity(db, "competition_judge_assignment", "comp-1:1")

    remaining = db.query_all("SELECT * FROM judge_competition_assignments WHERE competition_id = 'comp-1'")
    assert remaining == []


def test_delete_entity_rejects_invalid_assignment_id(db: Database) -> None:
    with pytest.raises(ValueError):
        delete_entity(db, "competition_judge_assignment", "comp-1:not-a-number")
