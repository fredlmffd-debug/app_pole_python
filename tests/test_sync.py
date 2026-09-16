from __future__ import annotations

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import competitors as competitors_service
from pole_scoring.services import judge_assignments as judge_assignments_service
from pole_scoring.services import judges as judges_service
from pole_scoring.services import sync as sync_service


def _seed_source(db: Database) -> dict:
    competition = competitions_service.create_competition(db, name="Comp Sync", event_date="2026-09-11", judge_count=1)
    judge = judges_service.add_judge(db, first_name="Alice", last_name="Martin", login="alice", password="secret")
    judge_assignments_service.set_competition_judge_assignment(
        db, competition_id=competition["id"], slot_index=1, judge_role="head", judge_id=judge["id"]
    )
    competitor = competitors_service.add_competitor(
        db, competition_id=competition["id"], first_name="Jeanne", last_name="Dupont", running_order=1
    )
    return {"competition": competition, "judge": judge, "competitor": competitor}


def test_build_full_sync_snapshot(bootstrapped_db: Database) -> None:
    seed = _seed_source(bootstrapped_db)
    snapshot = sync_service.build_full_sync_snapshot(bootstrapped_db)

    assert any(c["id"] == seed["competition"]["id"] for c in snapshot["competitions"])
    assert any(j["id"] == seed["judge"]["id"] for j in snapshot["judges"])
    assert any(c["id"] == seed["competitor"]["id"] for c in snapshot["competitors"])
    assert any(a["competition_id"] == seed["competition"]["id"] for a in snapshot["judgeAssignments"])


def test_export_and_import_sync_data_between_two_nodes(
    bootstrapped_db: Database, other_bootstrapped_db: Database
) -> None:
    seed = _seed_source(bootstrapped_db)
    exported = sync_service.export_sync_data(bootstrapped_db)

    target = other_bootstrapped_db
    result = sync_service.import_sync_data(target, exported)

    assert result["snapshotImported"]["competitions"] == 1
    assert result["snapshotImported"]["judges"] == 1
    assert result["snapshotImported"]["competitors"] == 1

    imported_competitions = competitions_service.list_competitions(target)
    assert [c["name"] for c in imported_competitions] == ["Comp Sync"]

    imported_judges = judges_service.list_judges(target)
    assert [j["login"] for j in imported_judges] == ["alice"]

    imported_competitors = competitors_service.list_competitors(target, seed["competition"]["id"])
    assert [c["stageName"] for c in imported_competitors] == ["Dupont Jeanne"]


def test_import_sync_data_is_idempotent_on_replay(
    bootstrapped_db: Database, other_bootstrapped_db: Database
) -> None:
    _seed_source(bootstrapped_db)
    exported = sync_service.export_sync_data(bootstrapped_db)

    target = other_bootstrapped_db
    first_result = sync_service.import_sync_data(target, exported)
    second_result = sync_service.import_sync_data(target, exported)

    assert first_result["importedCount"] == len(exported["events"])
    # Rejouer le meme export ne doit pas re-appliquer les evenements deja connus
    # (id de sync_events en PRIMARY KEY, INSERT OR IGNORE cote import).
    assert second_result["importedCount"] == 0
    assert len(competitions_service.list_competitions(target)) == 1


def test_apply_entity_rejects_unknown_type(bootstrapped_db: Database) -> None:
    import pytest

    with pytest.raises(ValueError):
        sync_service.apply_entity(bootstrapped_db, "unknown", {})


def test_import_full_sync_snapshot_handles_missing_snapshot(bootstrapped_db: Database) -> None:
    result = sync_service.import_full_sync_snapshot(bootstrapped_db, None)
    assert result == {"competitions": 0, "judges": 0, "competitors": 0, "judgeAssignments": 0, "scores": 0}


def test_export_sync_data_on_real_reference_data(reference_db: Database) -> None:
    exported = sync_service.export_sync_data(reference_db)
    assert exported["nodeId"]
    assert isinstance(exported["events"], list)
    assert isinstance(exported["snapshot"]["competitions"], list)
