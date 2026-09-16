from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import presenter as presenter_service
from ..utils.validation import require_string
from .deps import get_database

router = APIRouter(prefix="/api/presenter")


@router.get("/state")
def get_state(db: Database = Depends(get_database)) -> dict:
    return presenter_service.get_presenter_state(db)


@router.post("/active")
async def set_active_passage(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return presenter_service.set_presenter_active_passage(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
    )


@router.post("/finalize")
async def finalize_active_passage(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return presenter_service.finalize_presenter_active_passage(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        competitor_id=require_string(body.get("competitorId"), "competitorId"),
    )


@router.post("/results/enable")
def enable_results(db: Database = Depends(get_database)) -> dict:
    return presenter_service.enable_presenter_results_for_active_competition(db)


@router.post("/results/disable")
def disable_results(db: Database = Depends(get_database)) -> dict:
    return presenter_service.disable_presenter_results_for_active_competition(db)
