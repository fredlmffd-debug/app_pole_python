from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import access, competitions, judge_assignments, judges, presenter, scores, scoring, system
from .db.connection import get_db
from .services.system import get_lan_urls, get_summary

WEBUI_DIR = Path(__file__).resolve().parent / "webui"


def create_app() -> FastAPI:
    app = FastAPI()

    @app.exception_handler(ValueError)
    async def value_error_handler(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"error": str(exc) or "Erreur inconnue"})

    @app.exception_handler(json.JSONDecodeError)
    async def json_error_handler(_request: Request, _exc: json.JSONDecodeError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"error": "JSON invalide"})

    @app.get("/api/health")
    def health() -> dict:
        db = get_db()
        return {"status": "ok", **get_summary(db), "lanUrls": get_lan_urls()}

    app.include_router(access.router)
    app.include_router(competitions.router)
    app.include_router(judges.router)
    app.include_router(judge_assignments.router)
    app.include_router(scoring.router)
    app.include_router(scores.router)
    app.include_router(presenter.router)
    app.include_router(system.router)

    # Les routeurs restants (pdf, sync, db admin, ...) seront inclus ici au fil
    # des phases suivantes, avant le montage statique ci-dessous qui doit
    # rester en dernier (fallback fichiers + index.html).
    app.mount("/", StaticFiles(directory=WEBUI_DIR, html=True), name="webui")

    return app
