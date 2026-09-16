from __future__ import annotations

import sqlite3

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import db_maintenance


def test_export_database_snapshot_returns_valid_sqlite_bytes(bootstrapped_db: Database, tmp_path) -> None:
    competitions_service.create_competition(bootstrapped_db, name="Export Test", event_date="2026-09-01")

    exported = db_maintenance.export_database_snapshot(bootstrapped_db)
    assert exported["fileName"].startswith("pole-scoring-")
    assert exported["fileName"].endswith(".sqlite")
    assert len(exported["content"]) > 0

    written_path = tmp_path / "exported.sqlite"
    written_path.write_bytes(exported["content"])
    connection = sqlite3.connect(str(written_path))
    row = connection.execute("SELECT COUNT(*) FROM competitions").fetchone()
    connection.close()
    assert row[0] == 1


def test_import_database_snapshot_replaces_target_content(bootstrapped_db: Database, other_db: Database) -> None:
    competitions_service.create_competition(bootstrapped_db, name="Source Competition", event_date="2026-09-02")
    exported = db_maintenance.export_database_snapshot(bootstrapped_db)

    # `other_db` est un fichier independant, vide, sans grilles par defaut :
    # l'import doit tout remplacer, y compris les reglages/grilles.
    result = db_maintenance.import_database_snapshot(other_db, exported["content"])

    assert result["imported"] is True
    assert result["counts"]["competitions"] == 1

    imported_competitions = competitions_service.list_competitions(other_db)
    assert len(imported_competitions) == 1
    assert imported_competitions[0]["name"] == "Source Competition"


def test_import_database_snapshot_rejects_empty_buffer(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        db_maintenance.import_database_snapshot(bootstrapped_db, b"")


def test_archive_competitions_by_season_keeps_recent_and_archives_rest(bootstrapped_db: Database) -> None:
    recent = competitions_service.create_competition(bootstrapped_db, name="Recent", event_date="2026-10-01")
    older = competitions_service.create_competition(bootstrapped_db, name="Older", event_date="2020-10-01")

    result = db_maintenance.archive_competitions_by_season(bootstrapped_db, keep_seasons=1, purge=True)

    assert result["keptSeasonValues"] == [recent["season"]]
    assert result["archivedSeasonValues"] == [older["season"]]
    assert result["archiveFile"]["fileName"].endswith(".sqlite")
    assert result["purgeApplied"] is True
    assert result["purgedCompetitions"] == 1

    remaining = competitions_service.list_competitions(bootstrapped_db)
    assert [c["id"] for c in remaining] == [recent["id"]]

    archives = db_maintenance.list_database_archives(bootstrapped_db)
    assert any(a["fileName"] == result["archiveFile"]["fileName"] for a in archives)

    exported_archive = db_maintenance.export_database_archive(bootstrapped_db, result["archiveFile"]["fileName"])
    assert len(exported_archive["content"]) > 0


def test_archive_competitions_by_season_without_purge_keeps_live_data(bootstrapped_db: Database) -> None:
    competitions_service.create_competition(bootstrapped_db, name="Recent", event_date="2026-10-01")
    competitions_service.create_competition(bootstrapped_db, name="Older", event_date="2020-10-01")

    result = db_maintenance.archive_competitions_by_season(bootstrapped_db, keep_seasons=1, purge=False)

    assert result["purgeApplied"] is False
    assert result["purgedCompetitions"] == 0
    assert len(competitions_service.list_competitions(bootstrapped_db)) == 2


def test_archive_competitions_by_season_noop_when_under_threshold(bootstrapped_db: Database) -> None:
    competitions_service.create_competition(bootstrapped_db, name="Only one", event_date="2026-10-01")

    result = db_maintenance.archive_competitions_by_season(bootstrapped_db, keep_seasons=3, purge=True)

    assert result["archivedSeasonValues"] == []
    assert result["archiveFile"] is None


def test_restore_database_archive_merges_without_clobbering(
    bootstrapped_db: Database, other_bootstrapped_db: Database
) -> None:
    older = competitions_service.create_competition(bootstrapped_db, name="Older", event_date="2020-10-01")
    competitions_service.create_competition(bootstrapped_db, name="Recent", event_date="2026-10-01")

    archive_result = db_maintenance.archive_competitions_by_season(bootstrapped_db, keep_seasons=1, purge=True)
    archive_content = db_maintenance.export_database_archive(
        bootstrapped_db, archive_result["archiveFile"]["fileName"]
    )["content"]

    target = other_bootstrapped_db
    competitions_service.create_competition(target, name="Existing local", event_date="2026-01-01")

    result = db_maintenance.restore_database_archive(target, archive_content)

    assert result["restored"] is True
    assert result["insertedRows"]["competitions"] == 1

    names = {c["name"] for c in competitions_service.list_competitions(target)}
    assert names == {"Existing local", older["name"]}


def test_sanitize_archive_file_name_rejects_traversal() -> None:
    with pytest.raises(ValueError):
        db_maintenance.sanitize_archive_file_name("../../etc/passwd")

    with pytest.raises(ValueError):
        db_maintenance.sanitize_archive_file_name("not-sqlite.txt")

    assert db_maintenance.sanitize_archive_file_name("archive.sqlite") == "archive.sqlite"
