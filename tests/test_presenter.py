from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import presenter as presenter_service


def test_presenter_state_with_no_active_competition(bootstrapped_db: Database) -> None:
    state = presenter_service.get_presenter_state(bootstrapped_db)
    assert state["activePassage"] is None
    assert state["activeCompetition"] is None
    assert state["resultsEnabled"] is False
    assert state["progress"] == {"validated": 0, "total": 0}


def test_set_active_passage_requires_matching_competitor(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]

    with pytest.raises(ValueError):
        presenter_service.set_presenter_active_passage(
            db, competition_id=scoring_setup["competition"]["id"], competitor_id="unknown"
        )


def test_set_and_finalize_active_passage(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]

    state = presenter_service.set_presenter_active_passage(
        db, competition_id=competition_id, competitor_id=competitor_id
    )
    assert state["activePassage"]["id"] == competitor_id
    assert state["progress"]["total"] == 2  # deux juges assignes dans le fixture

    finalized = presenter_service.finalize_presenter_active_passage(
        db, competition_id=competition_id, competitor_id=competitor_id
    )
    assert finalized["competitorId"] == competitor_id
    assert presenter_service.get_presenter_active_passage(db) is None


def test_finalize_without_active_passage_fails(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    presenter_service.clear_presenter_active_passage(db)

    with pytest.raises(ValueError):
        presenter_service.finalize_presenter_active_passage(
            db, competition_id=scoring_setup["competition"]["id"], competitor_id=scoring_setup["competitor"]["id"]
        )


def test_presenter_state_tracks_validated_judges(scoring_setup: dict) -> None:
    from pole_scoring.services import scores as scores_service

    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]
    artistic_judge_id = scoring_setup["artistic_judge"]["id"]

    presenter_service.set_presenter_active_passage(db, competition_id=competition_id, competitor_id=competitor_id)

    scores_service.save_judge_scorecard(
        db,
        competition_id=competition_id,
        competitor_id=competitor_id,
        judge_id=artistic_judge_id,
        entries=[{"criterion": f"artistic:{i}", "score": 4.0} for i in range(1, 7)],
    )

    state = presenter_service.get_presenter_state(db)
    assert state["progress"] == {"validated": 1, "total": 2}
    validated = next(j for j in state["judges"] if j["id"] == artistic_judge_id)
    assert validated["status"] == "validated"


def test_enable_and_disable_presenter_results(bootstrapped_db: Database) -> None:
    with pytest.raises(ValueError):
        presenter_service.enable_presenter_results_for_active_competition(bootstrapped_db)

    competition = competitions_service.create_competition(bootstrapped_db, name="Comp Active", event_date="2026-09-12")
    competitions_service.update_competition(
        bootstrapped_db,
        competition_id=competition["id"],
        name=competition["name"],
        event_date=competition["eventDate"],
        status="active",
    )

    enabled = presenter_service.enable_presenter_results_for_active_competition(bootstrapped_db)
    assert enabled["enabled"] is True
    assert enabled["competitionId"] == competition["id"]

    state = presenter_service.get_presenter_state(bootstrapped_db)
    assert state["resultsEnabled"] is True
    assert state["resultsUrl"] == f"/competition-results.html?competitionId={competition['id']}&view=all"

    disabled = presenter_service.disable_presenter_results_for_active_competition(bootstrapped_db)
    assert disabled["enabled"] is False
    assert disabled["competitionId"] == competition["id"]


def test_dashboard_state_without_active_competition(bootstrapped_db: Database) -> None:
    state = presenter_service.get_dashboard_state(bootstrapped_db)
    assert state == {"activeCompetition": None, "judges": []}


def test_presenter_and_dashboard_state_on_real_reference_data(reference_db: Database) -> None:
    presenter_state = presenter_service.get_presenter_state(reference_db)
    assert "progress" in presenter_state

    dashboard_state = presenter_service.get_dashboard_state(reference_db)
    assert "activeCompetition" in dashboard_state


def test_dashboard_state_with_active_competition(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition = scoring_setup["competition"]

    competitions_service.update_competition(
        db, competition_id=competition["id"], name=competition["name"], event_date=competition["eventDate"], status="active"
    )

    state = presenter_service.get_dashboard_state(db)
    assert state["activeCompetition"]["id"] == competition["id"]
    assert len(state["judges"]) == 2
