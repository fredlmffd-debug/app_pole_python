"""Sous-ensemble minimal de l'etat presentateur (app_pole/src/db.js), pulle en
avance de phase car la saisie des notes (Phase 3) en depend : un score ne peut
etre enregistre que pour le passage actuellement actif sur la tablette
presentateur. Le reste (activer/finaliser un passage, activer les resultats)
sera porte en Phase 4."""

from __future__ import annotations

import json

from ..db.connection import Database
from ..db.settings import get_setting, set_setting

PRESENTER_ACTIVE_PASSAGE_KEY = "presenter_active_passage"


def get_presenter_active_passage(db: Database) -> dict | None:
    raw = get_setting(db, PRESENTER_ACTIVE_PASSAGE_KEY)

    if not raw:
        return None

    try:
        return json.loads(raw)
    except ValueError:
        return None


def clear_presenter_active_passage(db: Database) -> None:
    set_setting(db, PRESENTER_ACTIVE_PASSAGE_KEY, "")


def assert_presenter_passage_active(db: Database, competition_id: str, competitor_id: str) -> None:
    active_passage = get_presenter_active_passage(db)

    if not active_passage:
        raise ValueError("Aucun passage tablette actif")

    active_competition_id = str(active_passage.get("competitionId") or "").strip()
    active_competitor_id = str(active_passage.get("competitorId") or "").strip()

    if active_competition_id != competition_id or active_competitor_id != competitor_id:
        raise ValueError("Ce passage n'est plus actif sur tablette")
