from __future__ import annotations

from ..utils.ids import new_id
from ..utils.time import now
from .connection import Database


def set_setting(db: Database, key: str, value: str) -> None:
    db.execute(
        """
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, value, now()),
    )


def get_setting(db: Database, key: str) -> str | None:
    row = db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row is not None else None


def get_node_id(db: Database) -> str:
    node_id = get_setting(db, "node_id")

    if not node_id:
        node_id = new_id()
        set_setting(db, "node_id", node_id)

    return node_id


def build_competition_include_shadow_tablets_setting_key(competition_id: str) -> str:
    return f"competition:{competition_id}:include_shadow_tablets"


def get_competition_include_shadow_tablet_judges(db: Database, competition_id: str) -> bool:
    normalized_competition_id = str(competition_id or "").strip()

    if not normalized_competition_id:
        return False

    raw_value = str(
        get_setting(db, build_competition_include_shadow_tablets_setting_key(normalized_competition_id)) or ""
    ).strip().lower()
    return raw_value in ("1", "true", "yes", "on")


def set_competition_include_shadow_tablet_judges(
    db: Database, competition_id: str, include_shadow_tablet_judges: bool
) -> dict:
    normalized_competition_id = str(competition_id or "").strip()

    if not normalized_competition_id:
        raise ValueError("Compétition invalide")

    competition_exists = db.query_one(
        "SELECT id FROM competitions WHERE id = ?", (normalized_competition_id,)
    )

    if competition_exists is None:
        raise ValueError("Compétition introuvable")

    next_value = bool(include_shadow_tablet_judges)
    set_setting(
        db,
        build_competition_include_shadow_tablets_setting_key(normalized_competition_id),
        "1" if next_value else "0",
    )

    return {
        "competitionId": normalized_competition_id,
        "includeShadowTabletJudges": next_value,
    }
