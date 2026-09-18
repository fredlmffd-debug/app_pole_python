"""Vide les donnees de competition d'une base Pole Scoring tout en conservant
les comptes utilisateurs (access_accounts), les juges enregistres (judges)
et les grilles de notation (scoring_grids / versions / criteres).

Tables videes : competitions (cascade -> competitors, competitor_members,
scores, judge_competition_authorizations, judge_competition_assignments,
judge_presence, competitor_score_summaries), athletes, sync_events.

Une copie de sauvegarde horodatee du fichier .sqlite est creee avant toute
suppression.

Usage :
    .venv\\Scripts\\python.exe scripts\\reset-test-data.py --confirm
    (ajouter --data-dir <chemin> pour cibler une autre base que celle par
    defaut resolue via POLE_SCORING_DATA_DIR / config.py)
"""
from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pole_scoring.db.connection import Database  # noqa: E402

PRESERVED_TABLES = (
    "access_accounts",
    "access_sessions",
    "access_recovery_codes",
    "judges",
    "scoring_grids",
    "scoring_grid_versions",
    "scoring_grid_criteria",
    "settings",
)

TABLES_TO_COUNT = (
    "competitions",
    "competitors",
    "scores",
    "athletes",
    "sync_events",
    *PRESERVED_TABLES,
)


def print_counts(db: Database, label: str) -> None:
    print(f"--- {label} ---")
    for table in TABLES_TO_COUNT:
        count = db.query_one(f"SELECT COUNT(*) AS n FROM {table}")["n"]
        print(f"  {table}: {count}")


def backup_database_file(db_file: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = db_file.with_name(f"{db_file.stem}.before-reset-{timestamp}{db_file.suffix}")
    shutil.copy2(db_file, backup_path)
    return backup_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=None, help="Repertoire de donnees a cibler")
    parser.add_argument("--confirm", action="store_true", help="Confirme la suppression (obligatoire)")
    args = parser.parse_args()

    if args.data_dir:
        db_file = args.data_dir / "pole-scoring.sqlite"
    else:
        from pole_scoring.config import DB_FILE

        db_file = DB_FILE

    if not db_file.exists():
        print(f"Base introuvable : {db_file}")
        raise SystemExit(1)

    if not args.confirm:
        print(f"Base ciblee : {db_file}")
        print("Rien n'a ete modifie. Relancez avec --confirm pour effectuer la remise a zero.")
        raise SystemExit(0)

    db = Database(db_file)
    print(f"Base ciblee : {db_file}")
    print_counts(db, "Avant remise a zero")

    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    backup_path = backup_database_file(db_file)
    print(f"Sauvegarde de securite creee avant suppression : {backup_path}")

    with db.transaction():
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("DELETE FROM competitions")
        db.execute("DELETE FROM athletes")
        db.execute("DELETE FROM sync_events")

    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    print_counts(db, "Apres remise a zero")
    db.close()


if __name__ == "__main__":
    main()
