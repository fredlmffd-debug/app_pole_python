from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, Response

from ..db.connection import Database
from ..services import pdf_export as pdf_export_service
from ..utils.validation import require_string
from .deps import get_database, require_local_system_control

router = APIRouter(prefix="/api/pdf")


@router.post("/export")
async def export_pdf(request: Request, db: Database = Depends(get_database)) -> dict:
    require_local_system_control(request)
    body = await request.json()
    return await asyncio.to_thread(pdf_export_service.export_pdf, db, body)


@router.post("/open-folder")
async def open_folder(request: Request, db: Database = Depends(get_database)) -> dict:  # noqa: ARG001
    require_local_system_control(request)
    body = await request.json()
    category = pdf_export_service.resolve_pdf_export_category(body.get("type"))
    folder_path = pdf_export_service.PDF_EXPORT_ROOT / category["folder"]
    folder_path.mkdir(parents=True, exist_ok=True)
    opened = await asyncio.to_thread(pdf_export_service.open_path_in_explorer, str(folder_path))
    return {"ok": True, "opened": opened, "type": category["type"], "folderPath": str(folder_path)}


@router.get("/download")
def download(request: Request) -> Response:
    type_ = require_string(request.query_params.get("type"), "type")
    file_name = require_string(request.query_params.get("name"), "name")
    file = pdf_export_service.read_exported_pdf_file(type_, file_name)

    return Response(
        content=file["content"],
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{file["fileName"]}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/list")
def list_files(request: Request) -> dict:
    type_ = require_string(request.query_params.get("type"), "type")
    return pdf_export_service.list_exported_pdf_files(type_)


@router.get("/browse")
def browse(request: Request) -> HTMLResponse:
    type_ = require_string(request.query_params.get("type"), "type")
    return HTMLResponse(pdf_export_service.build_pdf_browse_html(type_))
