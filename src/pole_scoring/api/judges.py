from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import judges as judges_service
from ..utils.validation import require_string
from .deps import get_database

router = APIRouter(prefix="/api")


@router.get("/judges")
def list_judges(db: Database = Depends(get_database)) -> list[dict]:
    return judges_service.list_judges(db)


@router.post("/judges", status_code=201)
async def add_judge(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return judges_service.add_judge(
        db,
        first_name=require_string(body.get("firstName"), "firstName"),
        last_name=require_string(body.get("lastName"), "lastName"),
        login=require_string(body.get("login"), "login"),
        password=require_string(body.get("password"), "password"),
    )


@router.put("/judges/{judge_id}")
async def update_judge(judge_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return judges_service.update_judge(
        db,
        judge_id=judge_id,
        first_name=require_string(body.get("firstName"), "firstName"),
        last_name=require_string(body.get("lastName"), "lastName"),
        login=require_string(body.get("login"), "login"),
        password=body.get("password") if isinstance(body.get("password"), str) else "",
    )


@router.delete("/judges/{judge_id}")
def delete_judge(judge_id: str, db: Database = Depends(get_database)) -> dict:
    return judges_service.delete_judge(db, judge_id)


@router.post("/judges/{judge_id}/activity")
async def update_judge_activity(judge_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    raw_is_active = body.get("isActive")

    if raw_is_active is None:
        raise ValueError("Le champ isActive est obligatoire")

    is_active = raw_is_active is True or raw_is_active in (1, "1")
    return judges_service.update_judge_activity(db, judge_id=judge_id, is_active=is_active)


@router.post("/judge-logout")
async def judge_logout(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return judges_service.clear_judge_presence(
        db,
        competition_id=require_string(body.get("competitionId"), "competitionId"),
        judge_id=require_string(body.get("judgeId"), "judgeId"),
    )
