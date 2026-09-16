from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response

from ..db.connection import Database
from ..services import db_maintenance
from ..utils.validation import require_string
from .deps import get_database, require_access_account

router = APIRouter(prefix="/api/db")


def _sqlite_attachment_response(file_name: str, content: bytes) -> Response:
    return Response(
        content=content,
        media_type="application/vnd.sqlite3",
        headers={
            "Content-Disposition": f'attachment; filename="{file_name}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/export")
def export_database(db: Database = Depends(get_database)) -> Response:
    exported = db_maintenance.export_database_snapshot(db)
    return _sqlite_attachment_response(exported["fileName"], exported["content"])


@router.post("/import")
async def import_database(request: Request, db: Database = Depends(get_database)) -> dict:
    binary = await request.body()
    return db_maintenance.import_database_snapshot(db, binary)


@router.post("/archive")
async def archive_database(request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["super_admin"])
    body = await request.json()
    return db_maintenance.archive_competitions_by_season(
        db, keep_seasons=body.get("keepSeasons"), purge=body.get("purge") is not False
    )


@router.get("/archives")
def list_archives(request: Request, db: Database = Depends(get_database)) -> list[dict]:
    require_access_account(request, db, ["super_admin"])
    return db_maintenance.list_database_archives(db)


@router.get("/archive/download")
def download_archive(request: Request, db: Database = Depends(get_database)) -> Response:
    require_access_account(request, db, ["super_admin"])
    file_name = require_string(request.query_params.get("name"), "name")
    exported = db_maintenance.export_database_archive(db, file_name)
    return _sqlite_attachment_response(exported["fileName"], exported["content"])


@router.post("/archive/restore")
async def restore_archive(request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["super_admin"])
    binary = await request.body()
    return db_maintenance.restore_database_archive(db, binary)
