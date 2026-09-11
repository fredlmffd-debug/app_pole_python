from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

WEBUI_DIR = Path(__file__).resolve().parent / "webui"


def create_app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    # Les routeurs metier (competitions, juges, scores, presenter, pdf, sync, ...)
    # seront inclus ici via app.include_router(...) au fil des phases suivantes,
    # avant le montage statique ci-dessous qui doit rester en dernier.
    app.mount("/", StaticFiles(directory=WEBUI_DIR, html=True), name="webui")

    return app
