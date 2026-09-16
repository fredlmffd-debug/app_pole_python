from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import sync as sync_service
from .deps import get_database

router = APIRouter(prefix="/api/sync")


@router.get("/export")
def export_sync(db: Database = Depends(get_database)) -> dict:
    return sync_service.export_sync_data(db)


@router.post("/import")
async def import_sync(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return sync_service.import_sync_data(db, body)
