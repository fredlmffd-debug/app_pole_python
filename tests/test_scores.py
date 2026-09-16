from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import scores as scores_service
from tests.conftest import activate_presenter_passage


def test_add_score_validates_range_and_step(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]
    judge_id = scoring_setup["artistic_judge"]["id"]

    with pytest.raises(ValueError):
        scores_service.add_score(
            db, competition_id=competition_id, competitor_id=competitor_id, judge_id=judge_id,
            criterion="artistic:1", score=6,
        )

    with pytest.raises(ValueError):
        scores_service.add_score(
            db, competition_id=competition_id, competitor_id=competitor_id, judge_id=judge_id,
            criterion="artistic:1", score=4.3,
        )

    saved = scores_service.add_score(
        db, competition_id=competition_id, competitor_id=competitor_id, judge_id=judge_id,
        criterion="artistic:1", score=4.5,
    )
    assert saved["score"] == 4.5


def test_add_score_rejects_unauthorized_judge(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]

    with pytest.raises(ValueError):
        scores_service.add_score(
            db,
            competition_id=scoring_setup["competition"]["id"],
            competitor_id=scoring_setup["competitor"]["id"],
            judge_id="unknown-judge",
            criterion="artistic:1",
            score=4,
        )


def test_save_judge_draft_score_requires_active_passage(bootstrapped_db: Database) -> None:
    from pole_scoring.services import competitions as competitions_service
    from pole_scoring.services import judges as judges_service

    competition = competitions_service.create_competition(bootstrapped_db, name="Sans passage", event_date="2026-09-10")
    judge = judges_service.add_judge(bootstrapped_db, first_name="A", last_name="B", login="ab", password="secret")

    with pytest.raises(ValueError):
        scores_service.save_judge_draft_score(
            bootstrapped_db,
            competition_id=competition["id"],
            competitor_id="whatever",
            judge_id=judge["id"],
            criterion="artistic:1",
            score=4,
        )


def test_save_judge_draft_score_replaces_previous_value(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]
    judge_id = scoring_setup["artistic_judge"]["id"]

    scores_service.save_judge_draft_score(
        db, competition_id=competition_id, competitor_id=competitor_id, judge_id=judge_id,
        criterion="artistic:1", score=3,
    )
    result = scores_service.save_judge_draft_score(
        db, competition_id=competition_id, competitor_id=competitor_id, judge_id=judge_id,
        criterion="artistic:1", score=4.5,
    )

    assert result["deletedCount"] == 1
    scores = scores_service.list_competitor_scores(db, competition_id, competitor_id)
    matching = [s for s in scores if s["criterion"] == "artistic:1"]
    assert len(matching) == 1
    assert matching[0]["score"] == 4.5


def test_save_judge_scorecard_full_flow_updates_summary(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]
    artistic_judge_id = scoring_setup["artistic_judge"]["id"]
    head_judge_id = scoring_setup["head_judge"]["id"]

    artistic_criteria = [f"artistic:{i}" for i in range(1, 7)]
    result = scores_service.save_judge_scorecard(
        db,
        competition_id=competition_id,
        competitor_id=competitor_id,
        judge_id=artistic_judge_id,
        entries=[{"criterion": criterion, "score": 4.0} for criterion in artistic_criteria],
    )
    assert result["finalized"] is True
    assert result["savedCount"] == 6

    technical_criteria = [f"technical:{i}" for i in range(1, 7)]
    scores_service.save_judge_scorecard(
        db,
        competition_id=competition_id,
        competitor_id=competitor_id,
        judge_id=head_judge_id,
        entries=[{"criterion": criterion, "score": 3.0} for criterion in technical_criteria]
        + [{"criterion": "penalty:total", "score": 0.5}],
    )

    results = scores_service.get_results(db, competition_id)
    entry = next(r for r in results if r["id"] == competitor_id)
    assert entry["artisticScore"] == 24.0
    assert entry["technicalScore"] == 17.5  # 18 - 0.5 de penalite
    assert entry["finalScore"] == 41.5


def test_save_judge_scorecard_rejects_without_primary_entries(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]

    with pytest.raises(ValueError):
        scores_service.save_judge_scorecard(
            db,
            competition_id=scoring_setup["competition"]["id"],
            competitor_id=scoring_setup["competitor"]["id"],
            judge_id=scoring_setup["artistic_judge"]["id"],
            entries=[{"criterion": "judge:comment", "score": 0, "comment": "RAS"}],
        )


def test_save_manual_scores(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]
    artistic_judge_id = scoring_setup["artistic_judge"]["id"]

    entries = [{"judgeId": artistic_judge_id, "criterion": f"artistic:{i}", "score": 5.0} for i in range(1, 7)]
    result = scores_service.save_manual_scores(db, competition_id=competition_id, competitor_id=competitor_id, entries=entries)

    assert result["savedCount"] == 6
    assert result["finalizedJudgeCount"] == 1


def test_save_manual_scores_clears_active_passage_when_emptied(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    competitor_id = scoring_setup["competitor"]["id"]

    from pole_scoring.services.presenter import get_presenter_active_passage

    assert get_presenter_active_passage(db) is not None

    scores_service.save_manual_scores(db, competition_id=competition_id, competitor_id=competitor_id, entries=[])

    assert get_presenter_active_passage(db) is None


def test_list_judge_category_history_requires_category(scoring_setup: dict) -> None:
    db: Database = scoring_setup["db"]

    history = scores_service.list_judge_category_history(
        db,
        competition_id=scoring_setup["competition"]["id"],
        judge_id=scoring_setup["artistic_judge"]["id"],
        category="",
        before_running_order=5,
    )
    assert history == []


def test_list_judge_category_history_returns_previous_finalized_competitor(scoring_setup: dict) -> None:
    from pole_scoring.services import competitors as competitors_service

    db: Database = scoring_setup["db"]
    competition_id = scoring_setup["competition"]["id"]
    artistic_judge_id = scoring_setup["artistic_judge"]["id"]

    first_competitor = scoring_setup["competitor"]
    scores_service.save_judge_scorecard(
        db,
        competition_id=competition_id,
        competitor_id=first_competitor["id"],
        judge_id=artistic_judge_id,
        entries=[{"criterion": f"artistic:{i}", "score": 4.0} for i in range(1, 7)],
    )

    second_competitor = competitors_service.add_competitor(
        db, competition_id=competition_id, first_name="Marie", last_name="Curie", running_order=2, category="Senior"
    )
    activate_presenter_passage(db, competition_id, second_competitor["id"])

    history = scores_service.list_judge_category_history(
        db, competition_id=competition_id, judge_id=artistic_judge_id, category="Senior", before_running_order=2
    )

    assert len(history) == 1
    assert history[0]["competitorId"] == first_competitor["id"]
    assert history[0]["totalScore"] == 24.0


def test_get_results_on_real_reference_data(reference_db: Database) -> None:
    from pole_scoring.services import competitions as competitions_service

    competitions = competitions_service.list_competitions(reference_db)
    assert competitions

    for competition in competitions:
        results = scores_service.get_results(reference_db, competition["id"])
        assert isinstance(results, list)
