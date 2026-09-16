from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import scores as scores_service
from ..utils.validation import require_string
from .deps import get_database

router = APIRouter(prefix="/api")


@router.post("/scores", status_code=201)
async def add_score(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return scores_service.add_score(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
        judge_id=require_string(body.get("judgeId"), "judgeId"),
        criterion=require_string(body.get("criterion"), "criterion"),
        score=body.get("score"),
        comment=body.get("comment").strip() if isinstance(body.get("comment"), str) else "",
    )


@router.post("/judge-score-draft")
async def save_judge_draft_score(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return scores_service.save_judge_draft_score(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
        judge_id=require_string(body.get("judgeId"), "judgeId"),
        criterion=require_string(body.get("criterion"), "criterion"),
        score=body.get("score"),
        comment=body.get("comment").strip() if isinstance(body.get("comment"), str) else "",
    )


@router.post("/judge-scorecard")
async def save_judge_scorecard(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return scores_service.save_judge_scorecard(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
        judge_id=require_string(body.get("judgeId"), "judgeId"),
        entries=body.get("entries") if isinstance(body.get("entries"), list) else [],
    )


@router.post("/manual-scoring/save")
async def save_manual_scores(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return scores_service.save_manual_scores(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
        entries=body.get("entries") if isinstance(body.get("entries"), list) else [],
    )


@router.get("/judge-score-history")
def judge_score_history(request: Request, db: Database = Depends(get_database)) -> list[dict]:
    competition_id = require_string(request.query_params.get("competitionId"), "competitionId")
    judge_id = require_string(request.query_params.get("judgeId"), "judgeId")
    category = (request.query_params.get("category") or "").strip()

    if not category:
        return []

    before_running_order_raw = (request.query_params.get("beforeRunningOrder") or "").strip()
    try:
        before_running_order = int(before_running_order_raw)
    except ValueError:
        raise ValueError("Le champ beforeRunningOrder est obligatoire") from None

    limit_raw = (request.query_params.get("limit") or "").strip()
    try:
        limit = int(limit_raw)
    except ValueError:
        limit = 8

    return scores_service.list_judge_category_history(
        db,
        competition_id=competition_id,
        judge_id=judge_id,
        category=category,
        before_running_order=before_running_order,
        limit=limit,
    )


@router.get("/competitions/{competition_id}/results")
def get_results(competition_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    category = (request.query_params.get("category") or "").strip()
    return {
        "results": scores_service.get_results(db, competition_id, category),
        "scores": scores_service.list_scores(db, competition_id),
    }


@router.get("/competitions/{competition_id}/competitors/{competitor_id}/scores")
def get_competitor_scores(competition_id: str, competitor_id: str, db: Database = Depends(get_database)) -> list[dict]:
    return scores_service.list_competitor_scores(db, competition_id, competitor_id)
