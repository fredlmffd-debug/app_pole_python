"""Synchronisation inter-poste, portee depuis app_pole/src/db.js : chaque
poste scrutateur garde une base locale independante ; ce module exporte/
importe un instantane complet + le journal d'evenements (sync_events) pour
fusionner l'etat de plusieurs postes (cf. README de app_pole, section
"Reseau local")."""

from __future__ import annotations

import json

from ..db.connection import Database
from ..db.events import delete_entity
from ..db.settings import get_node_id
from ..utils.time import now
from . import competitions as competitions_service
from . import competitors as competitors_service
from . import judge_assignments as judge_assignments_service
from . import judges as judges_service
from . import scores as scores_service


def list_all_sync_snapshot_competitions(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT id, name, location, event_date, season, competition_level, region, zone, judge_count,
               COALESCE(scrutateur_name, '') AS scrutateur_name,
               COALESCE(delete_password_hash, '') AS delete_password_hash,
               COALESCE(artistic_solo_grid_version_id, '') AS artistic_solo_grid_version_id,
               COALESCE(artistic_duo_grid_version_id, '') AS artistic_duo_grid_version_id,
               COALESCE(technical_solo_grid_version_id, '') AS technical_solo_grid_version_id,
               COALESCE(technical_duo_grid_version_id, '') AS technical_duo_grid_version_id,
               status, created_at, updated_at
        FROM competitions
        ORDER BY updated_at ASC
        """
    )


def list_all_sync_snapshot_judges(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT id,
               COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS name,
               COALESCE(first_name, '') AS first_name,
               COALESCE(last_name, '') AS last_name,
               COALESCE(login, '') AS login,
               COALESCE(password_hash, '') AS password_hash,
               COALESCE(role, '') AS role,
               COALESCE(device_label, '') AS device_label,
               is_active, created_at, updated_at
        FROM judges
        ORDER BY updated_at ASC
        """
    )


def list_all_sync_snapshot_competitors(db: Database) -> list[dict]:
    competitors = db.query_all(
        """
        SELECT id, competition_id, stage_name,
               COALESCE(first_name, '') AS first_name,
               COALESCE(last_name, '') AS last_name,
               COALESCE(category, '') AS category,
               running_order,
               COALESCE(is_resident, 0) AS is_resident,
               COALESCE(status, 'registered') AS status,
               created_at, updated_at
        FROM competitors
        ORDER BY updated_at ASC
        """
    )
    members_by_competitor_id = competitors_service.list_competitor_members_by_competitor_ids(
        db, [competitor["id"] for competitor in competitors]
    )

    return [
        {**competitor, "members": members_by_competitor_id.get(competitor["id"], [])} for competitor in competitors
    ]


def list_all_sync_snapshot_judge_assignments(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT competition_id, slot_index,
               COALESCE(judge_role, '') AS judge_role,
               COALESCE(judge_id, '') AS judge_id,
               COALESCE(is_trainee, 0) AS is_trainee,
               updated_at
        FROM judge_competition_assignments
        ORDER BY competition_id ASC, slot_index ASC
        """
    )


def list_all_sync_snapshot_scores(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT id, competition_id, competitor_id, judge_id, criterion, score,
               COALESCE(comment, '') AS comment,
               source_node_id, created_at, updated_at
        FROM scores
        ORDER BY updated_at ASC
        """
    )


def build_full_sync_snapshot(db: Database) -> dict:
    return {
        "exportedAt": now(),
        "competitions": list_all_sync_snapshot_competitions(db),
        "judges": list_all_sync_snapshot_judges(db),
        "competitors": list_all_sync_snapshot_competitors(db),
        "judgeAssignments": list_all_sync_snapshot_judge_assignments(db),
        "scores": list_all_sync_snapshot_scores(db),
    }


def apply_entity(db: Database, entity_type: str, payload: dict) -> None:
    if entity_type == "competition_judge_assignment":
        judge_assignments_service.upsert_competition_judge_assignment(db, payload)
        return

    if entity_type == "competition":
        normalized = competitions_service.normalize_competition_payload(payload)
        competitions_service.assert_competition_identity_available(
            db, normalized["name"], normalized["event_date"], normalized["id"]
        )
        db.execute(competitions_service.COMPETITION_UPSERT_SQL, normalized)
        return

    if entity_type == "competitor":
        normalized = competitors_service.normalize_competitor_payload(payload)
        sql_payload = {key: value for key, value in normalized.items() if key != "members"}
        db.execute(competitors_service.COMPETITOR_UPSERT_SQL, sql_payload)
        competitors_service.sync_competitor_members(db, normalized)
        return

    if entity_type == "judge":
        normalized = judges_service.normalize_judge_payload(payload)
        db.execute(judges_service.JUDGE_UPSERT_SQL, normalized)
        return

    if entity_type == "score":
        db.execute(scores_service.SCORE_UPSERT_SQL, payload)
        return

    raise ValueError(f"Type d'entité non supporté: {entity_type}")


def import_full_sync_snapshot(db: Database, snapshot: dict | None) -> dict:
    if not isinstance(snapshot, dict):
        return {"competitions": 0, "judges": 0, "competitors": 0, "judgeAssignments": 0, "scores": 0}

    competitions = snapshot.get("competitions") if isinstance(snapshot.get("competitions"), list) else []
    judges = snapshot.get("judges") if isinstance(snapshot.get("judges"), list) else []
    competitors = snapshot.get("competitors") if isinstance(snapshot.get("competitors"), list) else []
    judge_assignments = (
        snapshot.get("judgeAssignments") if isinstance(snapshot.get("judgeAssignments"), list) else []
    )
    scores = snapshot.get("scores") if isinstance(snapshot.get("scores"), list) else []

    for competition in competitions:
        apply_entity(db, "competition", competition)

    for judge in judges:
        apply_entity(db, "judge", judge)

    for competitor in competitors:
        apply_entity(db, "competitor", competitor)

    for assignment in judge_assignments:
        apply_entity(db, "competition_judge_assignment", assignment)

    for score in scores:
        apply_entity(db, "score", score)

    return {
        "competitions": len(competitions),
        "judges": len(judges),
        "competitors": len(competitors),
        "judgeAssignments": len(judge_assignments),
        "scores": len(scores),
    }


def export_sync_data(db: Database) -> dict:
    events = db.query_all(
        """
        SELECT id, entity_type AS entityType, entity_id AS entityId, operation, payload,
               occurred_at AS occurredAt, source_node_id AS sourceNodeId
        FROM sync_events
        ORDER BY occurred_at ASC
        """
    )

    return {
        "nodeId": get_node_id(db),
        "exportedAt": now(),
        "snapshot": build_full_sync_snapshot(db),
        "events": [{**event, "payload": json.loads(event["payload"])} for event in events],
    }


def import_sync_data(db: Database, payload: dict | None) -> dict:
    payload = payload if isinstance(payload, dict) else {}
    events = payload.get("events") if isinstance(payload.get("events"), list) else []

    imported_count = 0

    with db.transaction():
        snapshot_imported = import_full_sync_snapshot(db, payload.get("snapshot"))

        for event in events:
            cursor = db.execute(
                """
                INSERT OR IGNORE INTO sync_events (id, entity_type, entity_id, operation, payload, occurred_at, source_node_id)
                VALUES (:id, :entity_type, :entity_id, :operation, :payload, :occurred_at, :source_node_id)
                """,
                {
                    "id": event.get("id"),
                    "entity_type": event.get("entityType"),
                    "entity_id": event.get("entityId"),
                    "operation": event.get("operation"),
                    "payload": json.dumps(event.get("payload")),
                    "occurred_at": event.get("occurredAt"),
                    "source_node_id": event.get("sourceNodeId"),
                },
            )

            if cursor.rowcount == 0:
                continue

            if event.get("operation") == "delete":
                delete_entity(db, event.get("entityType"), event.get("entityId"))
            else:
                apply_entity(db, event.get("entityType"), event.get("payload"))

            imported_count += 1

    return {"importedCount": imported_count, "snapshotImported": snapshot_imported, "nodeId": get_node_id(db)}
