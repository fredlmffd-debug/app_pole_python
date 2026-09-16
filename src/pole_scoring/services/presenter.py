"""Etat presentateur, porte depuis app_pole/src/db.js : passage actif get/clear
(Phase 3, car la validation d'un score en depend) et le reste (activer/finaliser
un passage, activer les resultats, etat complet, dashboard) en Phase 4."""

from __future__ import annotations

import json
from urllib.parse import quote

from ..db.connection import Database
from ..db.settings import get_competition_include_shadow_tablet_judges, get_setting, set_setting
from ..utils.time import now
from .competitions import get_active_competition_for_dashboard
from .competitors import get_competitor_by_id
from .judge_assignments import get_competition_judge_presence
from .judges import list_judges

PRESENTER_ACTIVE_PASSAGE_KEY = "presenter_active_passage"
PRESENTER_RESULTS_COMPETITION_ID_KEY = "presenter_results_competition_id"


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


def set_presenter_active_passage(db: Database, *, competition_id: str, competitor_id: str) -> dict:
    competitor = get_competitor_by_id(db, competitor_id)

    if competitor is None or competitor["competitionId"] != competition_id:
        raise ValueError("Passage actif invalide")

    set_setting(
        db,
        PRESENTER_ACTIVE_PASSAGE_KEY,
        json.dumps({"competitionId": competition_id, "competitorId": competitor_id, "updatedAt": now()}),
    )

    return get_presenter_state(db)


def finalize_presenter_active_passage(db: Database, *, competition_id: str, competitor_id: str) -> dict:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_competitor_id = str(competitor_id or "").strip()

    if not normalized_competition_id or not normalized_competitor_id:
        raise ValueError("Compétition ou passage invalide")

    assert_presenter_passage_active(db, normalized_competition_id, normalized_competitor_id)
    clear_presenter_active_passage(db)

    return {
        "competitionId": normalized_competition_id,
        "competitorId": normalized_competitor_id,
        "finalizedAt": now(),
        "presenter": get_presenter_state(db),
    }


def enable_presenter_results_for_active_competition(db: Database) -> dict:
    active_competition = get_active_competition_for_dashboard(db)

    if not active_competition or not active_competition.get("id"):
        raise ValueError("Aucune compétition active pour le présentateur")

    set_setting(db, PRESENTER_RESULTS_COMPETITION_ID_KEY, active_competition["id"])

    return {"competitionId": active_competition["id"], "enabled": True, "presenter": get_presenter_state(db)}


def disable_presenter_results_for_active_competition(db: Database) -> dict:
    previous_competition_id = str(get_setting(db, PRESENTER_RESULTS_COMPETITION_ID_KEY) or "").strip()
    set_setting(db, PRESENTER_RESULTS_COMPETITION_ID_KEY, "")

    return {"competitionId": previous_competition_id, "enabled": False, "presenter": get_presenter_state(db)}


def get_presenter_state(db: Database) -> dict:
    active_passage = get_presenter_active_passage(db)
    active_competitor = (
        get_competitor_by_id(db, active_passage["competitorId"])
        if active_passage and active_passage.get("competitorId")
        else None
    )
    active_competition = get_active_competition_for_dashboard(db)
    active_competition_id = str((active_competition or {}).get("id") or "").strip()
    results_competition_id = str(get_setting(db, PRESENTER_RESULTS_COMPETITION_ID_KEY) or "").strip()
    results_enabled = bool(active_competition_id) and results_competition_id == active_competition_id
    include_shadow_tablet_judges = (
        get_competition_include_shadow_tablet_judges(db, active_competition_id) if active_competition_id else False
    )
    results_url = (
        f"/competition-results.html?competitionId={quote(active_competition_id)}&view=all"
        if results_enabled
        else ""
    )
    judges = list_judges(db)

    if not active_competitor:
        return {
            "activePassage": None,
            "activeCompetition": active_competition,
            "resultsEnabled": results_enabled,
            "includeShadowTabletJudges": include_shadow_tablet_judges,
            "resultsUrl": results_url,
            "judges": [{**judge, "status": "pending"} for judge in judges],
            "progress": {"validated": 0, "total": len(judges)},
        }

    validated_judge_ids = {
        row["judgeId"]
        for row in db.query_all(
            "SELECT DISTINCT judge_id AS judgeId FROM scores WHERE competition_id = ? AND competitor_id = ?",
            (active_competitor["competitionId"], active_competitor["id"]),
        )
    }

    presenter_judges = [
        {**judge, "status": "validated" if judge["id"] in validated_judge_ids else "pending"} for judge in judges
    ]

    return {
        "activePassage": active_competitor,
        "activeCompetition": active_competition,
        "resultsEnabled": results_enabled,
        "includeShadowTabletJudges": include_shadow_tablet_judges,
        "resultsUrl": results_url,
        "judges": presenter_judges,
        "progress": {
            "validated": sum(1 for judge in presenter_judges if judge["status"] == "validated"),
            "total": len(presenter_judges),
        },
    }


def get_dashboard_state(db: Database) -> dict:
    active_competition = get_active_competition_for_dashboard(db)

    if not active_competition:
        return {"activeCompetition": None, "judges": []}

    presence = get_competition_judge_presence(db, active_competition["id"])

    return {"activeCompetition": active_competition, "judges": presence["judges"]}
