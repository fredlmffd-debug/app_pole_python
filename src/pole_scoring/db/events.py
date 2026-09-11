from __future__ import annotations

import json

from ..utils.ids import new_id
from ..utils.time import now
from .connection import Database

# Table cible pour chaque type d'entite du journal sync_events. Les
# upserts/normalisations par entite (competition, competitor, judge, ...)
# seront ajoutes phase par phase, au fur et a mesure que ces domaines sont
# portes (cf. applyEntity dans app_pole/src/db.js).
ENTITY_TABLES = {
    "competition": "competitions",
    "competitor": "competitors",
    "judge": "judges",
    "score": "scores",
    "competition_judge_assignment": "judge_competition_assignments",
}


def record_event(
    db: Database,
    entity_type: str,
    entity_id: str,
    operation: str,
    payload: dict,
    source_node_id: str,
) -> dict:
    event = {
        "id": new_id(),
        "entity_type": entity_type,
        "entity_id": entity_id,
        "operation": operation,
        "payload": json.dumps(payload),
        "occurred_at": payload.get("updated_at") or now(),
        "source_node_id": source_node_id,
    }

    db.execute(
        """
        INSERT INTO sync_events (id, entity_type, entity_id, operation, payload, occurred_at, source_node_id)
        VALUES (:id, :entity_type, :entity_id, :operation, :payload, :occurred_at, :source_node_id)
        """,
        event,
    )

    return event


def delete_entity(db: Database, entity_type: str, entity_id: str) -> None:
    if entity_type == "competition_judge_assignment":
        competition_id, _, raw_slot_index = str(entity_id or "").partition(":")

        try:
            slot_index = int(raw_slot_index.strip())
        except ValueError:
            slot_index = -1

        if not competition_id or slot_index < 1:
            raise ValueError("Identifiant d'attribution invalide")

        db.execute(
            "DELETE FROM judge_competition_assignments WHERE competition_id = ? AND slot_index = ?",
            (competition_id, slot_index),
        )
        return

    table = ENTITY_TABLES.get(entity_type)

    if not table:
        raise ValueError(f"Type d'entité non supporté: {entity_type}")

    db.execute(f"DELETE FROM {table} WHERE id = ?", (entity_id,))
