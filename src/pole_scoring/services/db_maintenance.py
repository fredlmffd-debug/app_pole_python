"""Export/import/archivage de la base SQLite complete, porte depuis
app_pole/src/db.js : ces operations manipulent directement le fichier
.sqlite (copie, ATTACH DATABASE, VACUUM), separement du reste des services
qui passent par le wrapper Database pour les requetes courantes."""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..db.connection import Database
from ..utils.ids import new_id
from ..utils.time import now
from ..utils.validation import parse_int_like_js
from .scores import refresh_all_competitor_score_summaries
from .scoring_grids import ensure_default_scoring_grids
from .system import get_summary

_IMPORT_DELETE_ORDER = [
    "competitor_score_summaries",
    "sync_events",
    "scores",
    "judge_presence",
    "judge_competition_assignments",
    "judge_competition_authorizations",
    "scoring_grid_criteria",
    "scoring_grid_versions",
    "competitor_members",
    "competitors",
    "athletes",
    "access_sessions",
    "access_accounts",
    "judges",
    "scoring_grids",
    "competitions",
    "settings",
]

_IMPORT_INSERT_ORDER = [
    "settings",
    "competitions",
    "scoring_grids",
    "scoring_grid_versions",
    "scoring_grid_criteria",
    "judges",
    "access_accounts",
    "access_sessions",
    "athletes",
    "competitors",
    "competitor_members",
    "judge_competition_authorizations",
    "judge_competition_assignments",
    "judge_presence",
    "scores",
    "sync_events",
]

_RESTORE_MERGE_ORDER = [
    "scoring_grids",
    "scoring_grid_versions",
    "scoring_grid_criteria",
    "judges",
    "competitions",
    "athletes",
    "competitors",
    "competitor_members",
    "judge_competition_authorizations",
    "judge_competition_assignments",
    "judge_presence",
    "scores",
    "sync_events",
]


def checkpoint_wal_and_get_db_files_size(db: Database) -> dict:
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    db_file = db.db_file
    sqlite_size = db_file.stat().st_size if db_file.exists() else 0
    wal_file = Path(f"{db_file}-wal")
    shm_file = Path(f"{db_file}-shm")
    wal_size = wal_file.stat().st_size if wal_file.exists() else 0
    shm_size = shm_file.stat().st_size if shm_file.exists() else 0

    return {
        "sqliteSize": sqlite_size,
        "walSize": wal_size,
        "shmSize": shm_size,
        "totalSize": sqlite_size + wal_size + shm_size,
    }


def export_database_snapshot(db: Database) -> dict:
    checkpoint_wal_and_get_db_files_size(db)

    file_name = now().replace(":", "-").replace(".", "-")
    return {"fileName": f"pole-scoring-{file_name}.sqlite", "content": db.db_file.read_bytes()}


def cleanup_orphan_athletes(db: Database) -> int:
    cursor = db.execute(
        "DELETE FROM athletes WHERE id NOT IN (SELECT DISTINCT athlete_id FROM competitor_members)"
    )
    return cursor.rowcount


def _cleanup_orphan_athletes_in(connection: sqlite3.Connection) -> int:
    cursor = connection.execute(
        "DELETE FROM athletes WHERE id NOT IN (SELECT DISTINCT athlete_id FROM competitor_members)"
    )
    return cursor.rowcount


def sanitize_archive_file_name(file_name: str | None) -> str:
    normalized = Path(str(file_name or "").strip()).name

    if not normalized or ".." in normalized or not normalized.endswith(".sqlite"):
        raise ValueError("Nom de fichier archive invalide")

    return normalized


def build_archive_file_name(archived_season_values: list[str]) -> str:
    first_season = archived_season_values[0] if archived_season_values else "unknown"
    last_season = archived_season_values[-1] if archived_season_values else "unknown"
    safe_first_season = re.sub(r"[^0-9/]", "", str(first_season)).replace("/", "-", 1)
    safe_last_season = re.sub(r"[^0-9/]", "", str(last_season)).replace("/", "-", 1)
    timestamp = now().replace(":", "-").replace(".", "-")

    return f"pole-scoring-archive-{safe_first_season}-to-{safe_last_season}-{timestamp}.sqlite"


def create_archive_file_for_seasons(db: Database, archived_season_values: list[str]) -> dict:
    if not archived_season_values:
        raise ValueError("Aucune saison à archiver")

    checkpoint_wal_and_get_db_files_size(db)

    archive_file_name = build_archive_file_name(archived_season_values)
    archives_dir = db.archives_dir
    archive_file_path = archives_dir / archive_file_name
    placeholders = ", ".join("?" for _ in archived_season_values)

    archives_dir.mkdir(parents=True, exist_ok=True)
    archive_file_path.write_bytes(db.db_file.read_bytes())

    archive_connection = sqlite3.connect(str(archive_file_path))

    try:
        archive_connection.execute("PRAGMA foreign_keys = OFF")
        archive_connection.execute("BEGIN")
        archive_connection.execute(
            f"DELETE FROM competitions WHERE season NOT IN ({placeholders})", tuple(archived_season_values)
        )
        _cleanup_orphan_athletes_in(archive_connection)
        archive_connection.execute("COMMIT")
        archive_connection.execute("VACUUM")
    except Exception:
        try:
            archive_connection.execute("ROLLBACK")
        except sqlite3.Error:
            pass

        archive_connection.close()

        if archive_file_path.exists():
            archive_file_path.unlink()

        raise
    else:
        archive_connection.close()

    return {
        "fileName": archive_file_name,
        "filePath": str(archive_file_path),
        "size": archive_file_path.stat().st_size,
        "seasons": archived_season_values,
    }


def list_database_archives(db: Database) -> list[dict]:
    archives_dir = db.archives_dir
    archives_dir.mkdir(parents=True, exist_ok=True)
    archives = []

    for entry in archives_dir.iterdir():
        if not entry.is_file() or not entry.name.endswith(".sqlite"):
            continue

        stats = entry.stat()
        archives.append(
            {
                "fileName": entry.name,
                "size": stats.st_size,
                "createdAt": _iso_from_timestamp(stats.st_ctime),
                "updatedAt": _iso_from_timestamp(stats.st_mtime),
            }
        )

    archives.sort(key=lambda item: item["updatedAt"], reverse=True)
    return archives


def _iso_from_timestamp(timestamp: float) -> str:
    moment = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def export_database_archive(db: Database, file_name: str) -> dict:
    safe_file_name = sanitize_archive_file_name(file_name)
    archive_path = db.archives_dir / safe_file_name

    if not archive_path.exists():
        raise ValueError("Archive introuvable")

    return {"fileName": safe_file_name, "content": archive_path.read_bytes()}


def archive_competitions_by_season(db: Database, keep_seasons: object = 3, purge: bool = True) -> dict:
    normalized_keep_seasons = min(max(parse_int_like_js(keep_seasons) or 3, 1), 10)

    seasons = [
        row["season"]
        for row in db.query_all(
            """
            SELECT DISTINCT season
            FROM competitions
            WHERE season GLOB '[0-9][0-9][0-9][0-9]/[0-9][0-9][0-9][0-9]'
            ORDER BY CAST(SUBSTR(season, 1, 4) AS INTEGER) DESC
            """
        )
    ]

    if len(seasons) <= normalized_keep_seasons:
        sizes = checkpoint_wal_and_get_db_files_size(db)
        return {
            "keepSeasons": normalized_keep_seasons,
            "keptSeasonValues": seasons,
            "archivedSeasonValues": [],
            "archiveFile": None,
            "purgedCompetitions": 0,
            "removedOrphanAthletes": 0,
            "purgeApplied": bool(purge),
            "size": sizes,
        }

    kept_season_values = seasons[:normalized_keep_seasons]
    archived_season_values = seasons[normalized_keep_seasons:]
    archive_file = create_archive_file_for_seasons(db, archived_season_values)

    if not purge:
        sizes = checkpoint_wal_and_get_db_files_size(db)
        return {
            "keepSeasons": normalized_keep_seasons,
            "keptSeasonValues": kept_season_values,
            "archivedSeasonValues": archived_season_values,
            "archiveFile": archive_file,
            "purgedCompetitions": 0,
            "removedOrphanAthletes": 0,
            "purgeApplied": False,
            "size": sizes,
        }

    placeholders = ", ".join("?" for _ in archived_season_values)

    with db.transaction():
        cursor = db.execute(
            f"DELETE FROM competitions WHERE season IN ({placeholders})", tuple(archived_season_values)
        )
        purged_competitions = cursor.rowcount
        removed_orphan_athletes = cleanup_orphan_athletes(db)

    db.execute("VACUUM")
    size = checkpoint_wal_and_get_db_files_size(db)

    return {
        "keepSeasons": normalized_keep_seasons,
        "keptSeasonValues": kept_season_values,
        "archivedSeasonValues": archived_season_values,
        "archiveFile": archive_file,
        "purgedCompetitions": purged_competitions,
        "removedOrphanAthletes": removed_orphan_athletes,
        "purgeApplied": True,
        "size": size,
    }


def _copy_tables_from_attached_db(
    connection: sqlite3.Connection, table_names: list[str], *, use_insert_or_ignore: bool
) -> dict[str, int]:
    inserted_rows: dict[str, int] = {}

    for table_name in table_names:
        target_columns = [row[1] for row in connection.execute(f"PRAGMA table_info({table_name})")]
        source_columns = [row[1] for row in connection.execute(f"PRAGMA importdb.table_info({table_name})")]
        source_set = set(source_columns)
        common_columns = [column for column in target_columns if column in source_set]

        if not common_columns:
            inserted_rows[table_name] = 0
            continue

        column_list = ", ".join(common_columns)
        verb = "INSERT OR IGNORE" if use_insert_or_ignore else "INSERT"
        cursor = connection.execute(
            f"{verb} INTO {table_name} ({column_list}) SELECT {column_list} FROM importdb.{table_name}"
        )
        inserted_rows[table_name] = cursor.rowcount

    return inserted_rows


def _run_attached_import(
    db: Database,
    temp_file_path: Path,
    *,
    delete_order: list[str] | None,
    insert_order: list[str],
    use_insert_or_ignore: bool,
) -> dict[str, int]:
    """ATTACH le fichier .sqlite temporaire, puis (option) vide les tables
    cibles dans `delete_order` avant de copier les colonnes communes de
    chaque table de `insert_order` depuis la base attachee. Les deux ordres
    sont volontairement distincts (contraintes de cles etrangeres), comme
    dans deleteOrder/insertOrder cote Node."""
    import_connection = sqlite3.connect(str(temp_file_path))
    attached = False

    try:
        import_connection.execute("SELECT name FROM sqlite_master WHERE type = ? LIMIT 1", ("table",)).fetchone()
        escaped_path = str(temp_file_path).replace("'", "''")

        db.execute("PRAGMA foreign_keys = OFF")

        with db.lock:
            connection = db.raw_connection

            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(f"ATTACH DATABASE '{escaped_path}' AS importdb")
                attached = True

                if delete_order is not None:
                    for table_name in delete_order:
                        connection.execute(f"DELETE FROM {table_name}")

                result = _copy_tables_from_attached_db(
                    connection, insert_order, use_insert_or_ignore=use_insert_or_ignore
                )

                connection.execute("COMMIT")
                connection.execute("DETACH DATABASE importdb")
                attached = False
            except Exception:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.Error:
                    pass

                if attached:
                    try:
                        connection.execute("DETACH DATABASE importdb")
                    except sqlite3.Error:
                        pass

                raise
            finally:
                db.execute("PRAGMA foreign_keys = ON")

        return result
    finally:
        import_connection.close()

        if temp_file_path.exists():
            temp_file_path.unlink()


def import_database_snapshot(db: Database, buffer: bytes) -> dict:
    if not isinstance(buffer, (bytes, bytearray)) or len(buffer) == 0:
        raise ValueError("Fichier SQLite invalide")

    temp_file_path = db.data_dir / f"import-{new_id()}.sqlite"
    temp_file_path.write_bytes(buffer)

    _run_attached_import(
        db,
        temp_file_path,
        delete_order=_IMPORT_DELETE_ORDER,
        insert_order=_IMPORT_INSERT_ORDER,
        use_insert_or_ignore=False,
    )

    ensure_default_scoring_grids(db)
    refresh_all_competitor_score_summaries(db)

    size = checkpoint_wal_and_get_db_files_size(db)

    return {"imported": True, "counts": get_summary(db)["counts"], "size": size}


def restore_database_archive(db: Database, buffer: bytes) -> dict:
    if not isinstance(buffer, (bytes, bytearray)) or len(buffer) == 0:
        raise ValueError("Fichier d'archive SQLite invalide")

    temp_file_path = db.data_dir / f"archive-restore-{new_id()}.sqlite"
    temp_file_path.write_bytes(buffer)

    inserted_rows = _run_attached_import(
        db,
        temp_file_path,
        delete_order=None,
        insert_order=_RESTORE_MERGE_ORDER,
        use_insert_or_ignore=True,
    )

    ensure_default_scoring_grids(db)
    refresh_all_competitor_score_summaries(db)

    return {
        "restored": True,
        "insertedRows": inserted_rows,
        "counts": get_summary(db)["counts"],
        "size": checkpoint_wal_and_get_db_files_size(db),
    }
