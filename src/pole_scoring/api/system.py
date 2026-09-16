from __future__ import annotations

from fastapi import APIRouter, Depends

from ..config import DB_FILE
from ..db.connection import Database
from ..services import presenter as presenter_service
from ..services import system as system_service
from ..services.competitions import list_competitions
from ..services.judges import list_judges
from .deps import get_database

router = APIRouter(prefix="/api")


@router.get("/bootstrap")
def bootstrap(db: Database = Depends(get_database)) -> dict:
    return {
        **system_service.get_summary(db),
        "dashboard": presenter_service.get_dashboard_state(db),
        "storage": {"dbFile": str(DB_FILE)},
        "lanUrls": system_service.get_lan_urls(),
        "competitions": list_competitions(db),
        "judges": list_judges(db),
    }
