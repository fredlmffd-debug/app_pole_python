from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from pole_scoring.db.bootstrap import run_startup_tasks
from pole_scoring.db.connection import Database
from pole_scoring.db.settings import set_setting
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import competitors as competitors_service
from pole_scoring.services import judge_assignments as judge_assignments_service
from pole_scoring.services import judges as judges_service
from pole_scoring.services.presenter import PRESENTER_ACTIVE_PASSAGE_KEY
from pole_scoring.utils.time import now


@pytest.fixture
def db(tmp_path) -> Database:
    database = Database(tmp_path / "pole-scoring.sqlite")
    yield database
    database.close()


@pytest.fixture
def bootstrapped_db(db) -> Database:
    """Base fraiche avec les taches de demarrage appliquees (grilles de
    notation par defaut, etc.) : necessaire pour les tests qui creent une
    competition, comme le ferait l'application au premier lancement."""
    run_startup_tasks(db)
    return db


def _default_reference_db_path() -> Path:
    return Path(__file__).resolve().parents[2] / "app_pole" / "data" / "pole-scoring.sqlite"


@pytest.fixture
def reference_db_copy(tmp_path) -> Path:
    """Copie isolee (backup API SQLite, lecture seule sur la source) de la
    vraie base app_pole, pour valider le portage sur des donnees reelles
    sans jamais toucher au fichier utilise par l'application Node en cours
    d'execution."""
    source_path = Path(os.environ.get("POLE_SCORING_REFERENCE_DB", _default_reference_db_path()))

    if not source_path.exists():
        pytest.skip(f"Base de référence introuvable: {source_path}")

    destination_path = tmp_path / "reference.sqlite"
    source_connection = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    destination_connection = sqlite3.connect(str(destination_path))
    source_connection.backup(destination_connection)
    destination_connection.close()
    source_connection.close()

    return destination_path


@pytest.fixture
def reference_db(reference_db_copy) -> Database:
    database = Database(reference_db_copy)
    run_startup_tasks(database)
    yield database
    database.close()


def activate_presenter_passage(db: Database, competition_id: str, competitor_id: str) -> None:
    """Equivalent minimal de setPresenterActivePassage (Phase 4 non portee) :
    juste ce qu'il faut pour que les tests de notation (Phase 3) puissent
    activer un passage sans dependre du reste du module presentateur."""
    import json

    set_setting(
        db,
        PRESENTER_ACTIVE_PASSAGE_KEY,
        json.dumps({"competitionId": competition_id, "competitorId": competitor_id, "updatedAt": now()}),
    )


@pytest.fixture
def scoring_setup(bootstrapped_db: Database) -> dict:
    """Competition + un juge 'head' (technique/penalites) + un juge
    'artistique', un competiteur solo, et le passage active sur ce
    competiteur : de quoi tester l'enregistrement de notes de bout en bout."""
    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp Notation", event_date="2026-09-01", judge_count=2
    )
    head_judge = judges_service.add_judge(
        bootstrapped_db, first_name="Head", last_name="Judge", login="head", password="secret"
    )
    artistic_judge = judges_service.add_judge(
        bootstrapped_db, first_name="Art", last_name="Judge", login="art", password="secret"
    )
    judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db, competition_id=competition["id"], slot_index=1, judge_role="head", judge_id=head_judge["id"]
    )
    judge_assignments_service.set_competition_judge_assignment(
        bootstrapped_db,
        competition_id=competition["id"],
        slot_index=2,
        judge_role="artistique",
        judge_id=artistic_judge["id"],
    )
    competitor = competitors_service.add_competitor(
        bootstrapped_db,
        competition_id=competition["id"],
        first_name="Jeanne",
        last_name="Dupont",
        running_order=1,
        category="Senior",
    )
    activate_presenter_passage(bootstrapped_db, competition["id"], competitor["id"])

    return {
        "db": bootstrapped_db,
        "competition": competition,
        "head_judge": head_judge,
        "artistic_judge": artistic_judge,
        "competitor": competitor,
    }
