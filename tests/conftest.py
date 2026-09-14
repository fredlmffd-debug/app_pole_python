from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from pole_scoring.db.bootstrap import run_startup_tasks
from pole_scoring.db.connection import Database


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
