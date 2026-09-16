from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..db.settings import set_competition_include_shadow_tablet_judges
from ..services import judge_assignments as judge_assignments_service
from ..utils.validation import require_number, require_string
from .deps import get_database

router = APIRouter(prefix="/api")


@router.get("/competitions/{competition_id}/judge-assignments")
def get_judge_assignments(competition_id: str, db: Database = Depends(get_database)) -> list[dict]:
    return judge_assignments_service.get_competition_judge_assignments(db, competition_id)


@router.post("/competitions/{competition_id}/judge-assignments")
async def set_judge_assignment(competition_id: str, request: Request, db: Database = Depends(get_database)) -> list[dict]:
    body = await request.json()
    return judge_assignments_service.set_competition_judge_assignment(
        db,
        competition_id=competition_id,
        slot_index=require_number(body.get("slotIndex"), "slotIndex"),
        judge_role=body.get("judgeRole") if isinstance(body.get("judgeRole"), str) else "",
        judge_id=body.get("judgeId") if isinstance(body.get("judgeId"), str) else "",
        is_trainee=bool(body.get("isTrainee")),
    )


@router.get("/competitions/{competition_id}/judge-presence")
def get_judge_presence(competition_id: str, db: Database = Depends(get_database)) -> dict:
    return judge_assignments_service.get_competition_judge_presence(db, competition_id)


@router.post("/competitions/{competition_id}/shadow-tablets")
async def set_shadow_tablets(competition_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return set_competition_include_shadow_tablet_judges(
        db, competition_id, bool(body.get("includeShadowTabletJudges"))
    )


@router.get("/judge-access")
def get_judge_access(request: Request, db: Database = Depends(get_database)) -> dict:
    competition_id = require_string(request.query_params.get("competitionId"), "competitionId")
    judge_id = require_string(request.query_params.get("judgeId"), "judgeId")
    return judge_assignments_service.get_judge_access_state(db, competition_id=competition_id, judge_id=judge_id)


@router.post("/judge-login")
async def judge_login(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return judge_assignments_service.authenticate_judge(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        login=require_string(body.get("login"), "login"),
        password=require_string(body.get("password"), "password"),
    )
