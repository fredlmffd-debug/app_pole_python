from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import competitions as competitions_service
from ..services import competitors as competitors_service
from ..services.competitors import parse_resident_flag
from ..utils.validation import optional_string, require_number, require_string
from .deps import get_database

router = APIRouter(prefix="/api")


def _ensure_competition_delete_password(db: Database, competition_id: str, value: object) -> None:
    if not competitions_service.has_competition_delete_password(db, competition_id):
        return

    if not isinstance(value, str) or value.strip() == "":
        raise ValueError("Le mot de passe scrutateur est requis pour supprimer une compétition")

    if not competitions_service.verify_competition_delete_password(db, competition_id, value):
        raise ValueError("Mot de passe scrutateur invalide")


@router.get("/competitions")
def list_competitions(db: Database = Depends(get_database)) -> list[dict]:
    return competitions_service.list_competitions(db)


@router.post("/competitions", status_code=201)
async def create_competition(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return competitions_service.create_competition(
        db,
        name=require_string(body.get("name"), "name"),
        location=optional_string(body.get("location")),
        event_date=optional_string(body.get("eventDate")),
        season=optional_string(body.get("season")),
        competition_level=optional_string(body.get("competitionLevel"), "defi"),
        region=optional_string(body.get("region")),
        zone=optional_string(body.get("zone")),
        judge_count=body.get("judgeCount"),
        scrutateur_name=optional_string(body.get("scrutateurName")),
        delete_password=body.get("deletePassword") if isinstance(body.get("deletePassword"), str) else "",
        status=optional_string(body.get("status"), "draft") or "draft",
    )


@router.put("/competitions/{competition_id}")
async def update_competition(competition_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    competition = competitions_service.update_competition(
        db,
        competition_id=competition_id,
        name=require_string(body.get("name"), "name"),
        location=optional_string(body.get("location")),
        event_date=optional_string(body.get("eventDate")),
        season=optional_string(body.get("season")),
        competition_level=optional_string(body.get("competitionLevel"), "defi"),
        region=optional_string(body.get("region")),
        zone=optional_string(body.get("zone")),
        judge_count=body.get("judgeCount"),
        scrutateur_name=body.get("scrutateurName") if isinstance(body.get("scrutateurName"), str) else None,
        delete_password=body.get("deletePassword") if isinstance(body.get("deletePassword"), str) else None,
        status=optional_string(body.get("status"), "draft") or "draft",
    )

    # Le nettoyage des PDF exportes a la cloture sera branche en Phase 5 (export PDF).
    return {**competition, "exportsCleanup": {"deletedCount": 0, "deletedFiles": []}}


@router.delete("/competitions/{competition_id}")
async def delete_competition(competition_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    _ensure_competition_delete_password(db, competition_id, body.get("password"))
    return competitions_service.delete_competition(db, competition_id)


@router.get("/competitions/{competition_id}/competitors")
def list_competitors(competition_id: str, db: Database = Depends(get_database)) -> list[dict]:
    return competitors_service.list_competitors(db, competition_id)


@router.post("/competitions/{competition_id}/competitors", status_code=201)
async def add_competitor(competition_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    raw_members = body.get("members")
    members = (
        [
            {
                "firstName": member.get("firstName") if isinstance(member.get("firstName"), str) else "",
                "lastName": member.get("lastName") if isinstance(member.get("lastName"), str) else "",
                "birthDate": member.get("birthDate") if isinstance(member.get("birthDate"), str) else "",
                "isResident": parse_resident_flag(
                    member.get("isResident", member.get("resident", member.get("residencyStatus")))
                ),
                "memberOrder": member.get("memberOrder"),
            }
            for member in raw_members
            if isinstance(member, dict)
        ]
        if isinstance(raw_members, list)
        else []
    )

    return competitors_service.add_competitor(
        db,
        competition_id=competition_id,
        stage_name=optional_string(body.get("stageName")),
        first_name=optional_string(body.get("firstName")),
        last_name=optional_string(body.get("lastName")),
        birth_date=optional_string(body.get("birthDate")),
        members=members,
        category=optional_string(body.get("category")),
        running_order=require_number(body.get("runningOrder"), "runningOrder"),
        is_resident=parse_resident_flag(
            body.get("isResident", body.get("resident", body.get("residencyStatus")))
        ),
    )


@router.delete("/competitions/{competition_id}/competitors")
def replace_competitors(competition_id: str, db: Database = Depends(get_database)) -> dict:
    return competitors_service.replace_competition_competitors(db, competition_id)


@router.post("/competitors/{competitor_id}/status")
async def update_competitor_status(competitor_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return competitors_service.update_competitor_status(
        db, competitor_id=competitor_id, status=require_string(body.get("status"), "status")
    )
