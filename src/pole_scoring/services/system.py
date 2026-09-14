from __future__ import annotations

import socket

from ..config import APP_PORT
from ..db.connection import Database
from ..db.settings import get_node_id


def get_summary(db: Database) -> dict:
    def count(table: str) -> int:
        return db.query_one(f"SELECT COUNT(*) AS count FROM {table}")["count"]

    return {
        "nodeId": get_node_id(db),
        "counts": {
            "competitions": count("competitions"),
            "competitors": count("competitors"),
            "judges": count("judges"),
            "scores": count("scores"),
            "syncEvents": count("sync_events"),
        },
    }


def get_lan_urls() -> list[str]:
    try:
        _, _, addresses = socket.gethostbyname_ex(socket.gethostname())
    except OSError:
        return []

    return [f"http://{address}:{APP_PORT}" for address in addresses if not address.startswith("127.")]
