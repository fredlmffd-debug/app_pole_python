from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import scoring_grids as scoring_grids_service
from ..utils.validation import require_string
from .deps import get_database, require_access_account

router = APIRouter(prefix="/api")


@router.get("/scoring/grids")
def list_grids(request: Request, db: Database = Depends(get_database)) -> list[dict]:
    require_access_account(request, db, ["admin", "scrutateur"])
    return scoring_grids_service.list_scoring_grids(db)


@router.get("/scoring/criteria")
def list_criteria(request: Request, db: Database = Depends(get_database)) -> list[dict]:
    require_access_account(request, db, ["admin", "scrutateur"])
    return scoring_grids_service.list_scoring_criteria_catalog(db)


@router.post("/scoring/criteria", status_code=201)
async def create_criterion(request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin", "scrutateur"])
    body = await request.json()
    return scoring_grids_service.create_scoring_criterion(
        db,
        grid_key=require_string(body.get("gridKey"), "gridKey"),
        label=require_string(body.get("label"), "label"),
        sort_order=body.get("sortOrder"),
    )


@router.put("/scoring/criteria/{criterion_id}")
async def revise_criterion(criterion_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin", "scrutateur"])
    body = await request.json()
    return scoring_grids_service.revise_scoring_criterion(
        db, criterion_id=criterion_id, label=require_string(body.get("label"), "label")
    )


@router.post("/scoring/grids/{grid_key}/versions", status_code=201)
async def create_grid_version(grid_key: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    body = await request.json()
    return scoring_grids_service.create_scoring_grid_version(
        db,
        grid_key=grid_key,
        criteria=body.get("criteria") if isinstance(body.get("criteria"), list) else [],
        score_min=body.get("scoreMin"),
        score_max=body.get("scoreMax"),
        score_step=body.get("scoreStep"),
        activate=body.get("activate") is not False,
    )


@router.post("/scoring/grids/{grid_key}/active-version")
async def set_active_grid_version(grid_key: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    body = await request.json()
    return scoring_grids_service.set_active_scoring_grid_version(
        db, grid_key=grid_key, version_id=require_string(body.get("versionId"), "versionId")
    )


@router.get("/competitions/{competition_id}/scoring-profile")
def get_scoring_profile(competition_id: str, db: Database = Depends(get_database)) -> dict:
    return scoring_grids_service.get_competition_scoring_profile(db, competition_id)
