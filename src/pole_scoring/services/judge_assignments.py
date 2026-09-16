from __future__ import annotations

from datetime import datetime, timezone

from ..db.connection import Database
from ..db.events import record_event
from ..db.settings import get_competition_include_shadow_tablet_judges, get_node_id
from ..services.competitions import get_competition_row_by_id, normalize_judge_count
from ..services.judges import is_judge_authorized_for_competition
from ..utils.security import hash_password
from ..utils.time import now

JUDGE_ASSIGNMENT_ROLES = {"head", "artistique", "technique"}


def normalize_judge_assignment_role(value: str | None) -> str:
    normalized_value = str(value or "").strip().lower()
    return normalized_value if normalized_value in JUDGE_ASSIGNMENT_ROLES else ""


def get_competition_judge_assignments(db: Database, competition_id: str) -> list[dict]:
    competition = get_competition_row_by_id(db, competition_id)

    if competition is None:
        raise ValueError("Compétition introuvable")

    rows = db.query_all(
        """
        SELECT a.slot_index AS slotIndex,
               COALESCE(a.judge_role, '') AS judgeRole,
               COALESCE(a.judge_id, '') AS judgeId,
               COALESCE(a.is_trainee, 0) AS isTrainee,
               a.updated_at AS updatedAt,
               COALESCE(NULLIF(j.name, ''), TRIM(COALESCE(j.first_name, '') || ' ' || COALESCE(j.last_name, ''))) AS judgeName,
               COALESCE(j.first_name, '') AS judgeFirstName,
               COALESCE(j.last_name, '') AS judgeLastName,
               COALESCE(j.login, '') AS judgeLogin
        FROM judge_competition_assignments a
        LEFT JOIN judges j ON j.id = a.judge_id
        WHERE a.competition_id = ?
        ORDER BY a.slot_index
        """,
        (competition_id,),
    )

    assignment_by_slot = {row["slotIndex"]: row for row in rows}
    planned_judge_count = normalize_judge_count(competition["judgeCount"])

    assignments = []
    for index in range(planned_judge_count):
        slot_index = index + 1
        assignment = assignment_by_slot.get(slot_index)
        assignments.append(
            {
                "slotIndex": slot_index,
                "judgeRole": normalize_judge_assignment_role(assignment["judgeRole"] if assignment else None),
                "judgeId": assignment["judgeId"] if assignment else "",
                "isTrainee": bool(assignment and assignment["isTrainee"] == 1),
                "judgeName": assignment["judgeName"] if assignment else "",
                "judgeFirstName": assignment["judgeFirstName"] if assignment else "",
                "judgeLastName": assignment["judgeLastName"] if assignment else "",
                "judgeLogin": assignment["judgeLogin"] if assignment else "",
                "updatedAt": assignment["updatedAt"] if assignment else "",
            }
        )

    return assignments


def _upsert_competition_judge_assignment(db: Database, payload: dict) -> None:
    db.execute(
        """
        INSERT INTO judge_competition_assignments (competition_id, slot_index, judge_role, judge_id, is_trainee, updated_at)
        VALUES (:competition_id, :slot_index, :judge_role, :judge_id, :is_trainee, :updated_at)
        ON CONFLICT(competition_id, slot_index) DO UPDATE SET
          judge_role = excluded.judge_role,
          judge_id = excluded.judge_id,
          is_trainee = excluded.is_trainee,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at > judge_competition_assignments.updated_at
        """,
        payload,
    )


def set_competition_judge_assignment(
    db: Database,
    *,
    competition_id: str,
    slot_index: object,
    judge_role: str = "",
    judge_id: str = "",
    is_trainee: bool = False,
) -> list[dict]:
    competition = get_competition_row_by_id(db, competition_id)

    if competition is None:
        raise ValueError("Compétition introuvable")

    try:
        normalized_slot_index = int(slot_index)
    except (TypeError, ValueError):
        normalized_slot_index = -1

    if normalized_slot_index < 1 or normalized_slot_index > normalize_judge_count(competition["judgeCount"]):
        raise ValueError("Ligne d'affectation invalide")

    normalized_judge_role = normalize_judge_assignment_role(judge_role)
    normalized_judge_id = str(judge_id or "").strip()
    normalized_is_trainee = bool(is_trainee)

    if normalized_judge_id:
        if db.query_one("SELECT id FROM judges WHERE id = ?", (normalized_judge_id,)) is None:
            raise ValueError("Juge introuvable")

        conflicting_assignment = db.query_one(
            """
            SELECT slot_index AS slotIndex
            FROM judge_competition_assignments
            WHERE competition_id = ? AND judge_id = ? AND slot_index <> ?
            """,
            (competition_id, normalized_judge_id, normalized_slot_index),
        )

        if conflicting_assignment:
            raise ValueError("Ce juge est déjà affecté à une autre ligne")

    node_id = get_node_id(db)

    if not normalized_judge_role and not normalized_judge_id and not normalized_is_trainee:
        deleted_at = now()

        with db.transaction():
            db.execute(
                "DELETE FROM judge_competition_assignments WHERE competition_id = ? AND slot_index = ?",
                (competition_id, normalized_slot_index),
            )
            record_event(
                db,
                "competition_judge_assignment",
                f"{competition_id}:{normalized_slot_index}",
                "delete",
                {"competition_id": competition_id, "slot_index": normalized_slot_index, "updated_at": deleted_at},
                node_id,
            )

        return get_competition_judge_assignments(db, competition_id)

    assignment_updated_at = now()
    assignment_payload = {
        "competition_id": competition_id,
        "slot_index": normalized_slot_index,
        "judge_role": normalized_judge_role,
        "judge_id": normalized_judge_id or None,
        "is_trainee": 1 if normalized_is_trainee else 0,
        "updated_at": assignment_updated_at,
    }

    with db.transaction():
        _upsert_competition_judge_assignment(db, assignment_payload)
        record_event(
            db,
            "competition_judge_assignment",
            f"{competition_id}:{normalized_slot_index}",
            "upsert",
            assignment_payload,
            node_id,
        )

    return get_competition_judge_assignments(db, competition_id)


def touch_judge_presence(db: Database, competition_id: str, judge_id: str) -> None:
    db.execute(
        """
        INSERT INTO judge_presence (competition_id, judge_id, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(competition_id, judge_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        """,
        (competition_id, judge_id, now()),
    )


def get_competition_judge_presence(db: Database, competition_id: str) -> dict:
    competition = db.query_one(
        """
        SELECT id, name, location, event_date AS eventDate, season, competition_level AS competitionLevel,
               region, zone, judge_count AS judgeCount, COALESCE(scrutateur_name, '') AS scrutateurName, status
        FROM competitions
        WHERE id = ?
        """,
        (competition_id,),
    )

    if competition is None:
        raise ValueError("Compétition introuvable")

    rows = db.query_all(
        """
        SELECT j.id,
               a.slot_index AS slotIndex,
               COALESCE(NULLIF(j.name, ''), TRIM(COALESCE(j.first_name, '') || ' ' || COALESCE(j.last_name, ''))) AS name,
               COALESCE(j.first_name, '') AS firstName,
               COALESCE(j.last_name, '') AS lastName,
               COALESCE(j.login, '') AS login,
               COALESCE(a.judge_role, '') AS judgeRole,
               COALESCE(a.is_trainee, 0) AS isTrainee,
               COALESCE(p.last_seen_at, '') AS lastSeenAt
        FROM judges j
        INNER JOIN judge_competition_assignments a ON a.judge_id = j.id AND a.competition_id = ?
        LEFT JOIN judge_presence p ON p.competition_id = a.competition_id AND p.judge_id = j.id
        ORDER BY a.slot_index ASC
        """,
        (competition_id,),
    )

    now_moment = datetime.now(timezone.utc)
    judges = []
    for row in rows:
        last_seen_at = row["lastSeenAt"] or None
        if last_seen_at:
            try:
                elapsed_ms = (now_moment - datetime.fromisoformat(last_seen_at.replace("Z", "+00:00"))).total_seconds() * 1000
            except ValueError:
                elapsed_ms = float("inf")
        else:
            elapsed_ms = float("inf")

        judges.append(
            {
                **row,
                "isTrainee": row["isTrainee"] == 1,
                "lastSeenAt": last_seen_at,
                "isConnected": elapsed_ms <= 30_000,
            }
        )

    return {
        "competition": competition,
        "includeShadowTabletJudges": get_competition_include_shadow_tablet_judges(db, competition_id),
        "judges": judges,
    }


def get_judge_access_state(db: Database, *, competition_id: str, judge_id: str) -> dict:
    competition = db.query_one(
        """
        SELECT id, name, location, event_date AS eventDate, season, competition_level AS competitionLevel,
               region, zone, judge_count AS judgeCount, COALESCE(scrutateur_name, '') AS scrutateurName, status
        FROM competitions
        WHERE id = ?
        """,
        (competition_id,),
    )
    judge = db.query_one(
        """
        SELECT id,
               COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS name,
               COALESCE(first_name, '') AS firstName,
               COALESCE(last_name, '') AS lastName,
               COALESCE(login, '') AS login,
               is_active AS isActive
        FROM judges
        WHERE id = ?
        """,
        (judge_id,),
    )

    if competition is None:
        raise ValueError("Compétition introuvable")

    if judge is None:
        raise ValueError("Juge introuvable")

    if judge["isActive"] != 1:
        raise ValueError("Ce juge est désactivé")

    is_authorized = is_judge_authorized_for_competition(db, competition_id, judge_id)
    assignment = db.query_one(
        """
        SELECT COALESCE(judge_role, '') AS judgeRole, COALESCE(is_trainee, 0) AS isTrainee
        FROM judge_competition_assignments
        WHERE competition_id = ? AND judge_id = ?
        """,
        (competition_id, judge_id),
    )

    if is_authorized:
        touch_judge_presence(db, competition_id, judge_id)

    return {
        "competition": competition,
        "judge": judge,
        "isAuthorized": is_authorized,
        "judgeRole": assignment["judgeRole"] if assignment else "",
        "isTrainee": bool(assignment and assignment["isTrainee"] == 1),
    }


def authenticate_judge(db: Database, *, competition_id: str, login: str, password: str) -> dict:
    judge = db.query_one(
        "SELECT id, password_hash AS passwordHash, is_active AS isActive FROM judges WHERE login = ?",
        (str(login or "").strip(),),
    )

    if judge is None:
        raise ValueError("Utilisateur inconnu")

    if not judge["passwordHash"] or judge["passwordHash"] != hash_password(password):
        raise ValueError("Mot de passe incorrect")

    if judge["isActive"] != 1:
        raise ValueError("Ce juge est désactivé")

    return get_judge_access_state(db, competition_id=competition_id, judge_id=judge["id"])
