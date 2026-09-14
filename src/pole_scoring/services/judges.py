from __future__ import annotations

from ..db.connection import Database
from ..db.events import record_event, delete_entity
from ..db.settings import get_node_id
from ..utils.ids import new_id
from ..utils.security import hash_password
from ..utils.time import next_timestamp_after, now

JUDGE_UPSERT_SQL = """
INSERT INTO judges (
  id, name, first_name, last_name, login, password_hash, role, device_label, is_active,
  created_at, updated_at
)
VALUES (
  :id, :name, :first_name, :last_name, :login, :password_hash, :role, :device_label, :is_active,
  :created_at, :updated_at
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  login = excluded.login,
  password_hash = excluded.password_hash,
  role = excluded.role,
  device_label = excluded.device_label,
  is_active = excluded.is_active,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > judges.updated_at
"""


def normalize_login(value: str | None) -> str:
    return str(value or "").strip()


def build_judge_name(first_name: str, last_name: str, fallback_name: str = "") -> str:
    full_name = " ".join(part for part in (str(first_name or "").strip(), str(last_name or "").strip()) if part)
    return full_name or str(fallback_name or "").strip()


def normalize_judge_payload(payload: dict) -> dict:
    first_name = str(payload.get("first_name") or payload.get("firstName") or payload.get("name") or "").strip()
    last_name = str(payload.get("last_name") or payload.get("lastName") or "").strip()
    login = normalize_login(payload.get("login"))
    password_hash = str(payload.get("password_hash") or payload.get("passwordHash") or "").strip()
    raw_is_active = payload.get("is_active", payload.get("isActive"))
    is_active = 1 if raw_is_active is None else (1 if raw_is_active in (True, 1, "1") else 0)

    return {
        **payload,
        "name": build_judge_name(first_name, last_name, payload.get("name")),
        "first_name": first_name,
        "last_name": last_name,
        "login": login,
        "password_hash": password_hash,
        "role": str(payload.get("role") or "").strip(),
        "device_label": str(payload.get("device_label") or payload.get("deviceLabel") or "").strip(),
        "is_active": is_active,
    }


JUDGE_ROW_SELECT = """
SELECT id,
       COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS name,
       COALESCE(first_name, '') AS firstName,
       COALESCE(last_name, '') AS lastName,
       COALESCE(login, '') AS login,
       is_active AS isActive,
       created_at AS createdAt,
       updated_at AS updatedAt
FROM judges
WHERE id = ?
"""


def get_judge_by_id(db: Database, judge_id: str) -> dict | None:
    return db.query_one(JUDGE_ROW_SELECT, (judge_id,))


def is_judge_authorized_for_competition(db: Database, competition_id: str, judge_id: str) -> bool:
    row = db.query_one(
        "SELECT judge_id AS judgeId FROM judge_competition_assignments WHERE competition_id = ? AND judge_id = ?",
        (competition_id, judge_id),
    )
    return bool(row and row["judgeId"])


def list_judges(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT id,
               COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS name,
               COALESCE(first_name, '') AS firstName,
               COALESCE(last_name, '') AS lastName,
               COALESCE(login, '') AS login,
               is_active AS isActive,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM judges
        ORDER BY lastName, firstName, name
        """
    )


def _judge_full_row(db: Database, judge_id: str) -> dict | None:
    return db.query_one(
        """
        SELECT id,
               COALESCE(NULLIF(name, ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) AS name,
               COALESCE(first_name, '') AS firstName,
               COALESCE(last_name, '') AS lastName,
               COALESCE(login, '') AS login,
               COALESCE(password_hash, '') AS passwordHash,
               COALESCE(role, '') AS role,
               COALESCE(device_label, '') AS deviceLabel,
               is_active AS isActive,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM judges
        WHERE id = ?
        """,
        (judge_id,),
    )


def add_judge(db: Database, *, first_name: str, last_name: str, login: str, password: str) -> dict:
    normalized_login = normalize_login(login)

    if db.query_one("SELECT id FROM judges WHERE login = ?", (normalized_login,)):
        raise ValueError("Ce login existe déjà")

    timestamp = now()
    judge = normalize_judge_payload(
        {
            "id": new_id(),
            "first_name": first_name,
            "last_name": last_name,
            "login": normalized_login,
            "password_hash": hash_password(password),
            "role": "",
            "device_label": "",
            "is_active": 1,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )

    with db.transaction():
        db.execute(JUDGE_UPSERT_SQL, judge)
        record_event(db, "judge", judge["id"], "upsert", judge, get_node_id(db))

    return get_judge_by_id(db, judge["id"])


def update_judge(db: Database, *, judge_id: str, first_name: str, last_name: str, login: str, password: str = "") -> dict:
    existing_judge = _judge_full_row(db, judge_id)

    if existing_judge is None:
        raise ValueError("Juge introuvable")

    normalized_login = normalize_login(login)
    login_owner = db.query_one("SELECT id FROM judges WHERE login = ?", (normalized_login,))

    if login_owner and login_owner["id"] != judge_id:
        raise ValueError("Ce login existe déjà")

    trimmed_password = str(password or "").strip()
    next_password_hash = hash_password(trimmed_password) if trimmed_password else existing_judge["passwordHash"]

    judge = normalize_judge_payload(
        {
            "id": existing_judge["id"],
            "first_name": first_name,
            "last_name": last_name,
            "login": normalized_login,
            "password_hash": next_password_hash,
            "role": existing_judge["role"],
            "device_label": existing_judge["deviceLabel"],
            "is_active": existing_judge["isActive"],
            "created_at": existing_judge["createdAt"],
            "updated_at": next_timestamp_after(existing_judge["updatedAt"]),
        }
    )

    with db.transaction():
        db.execute(JUDGE_UPSERT_SQL, judge)
        record_event(db, "judge", judge["id"], "upsert", judge, get_node_id(db))

    return get_judge_by_id(db, judge["id"])


def update_judge_activity(db: Database, *, judge_id: str, is_active: bool) -> dict:
    judge = _judge_full_row(db, judge_id)

    if judge is None:
        raise ValueError("Juge introuvable")

    next_is_active = 1 if is_active else 0

    if judge["isActive"] == next_is_active:
        return get_judge_by_id(db, judge_id)

    payload = normalize_judge_payload(
        {
            "id": judge["id"],
            "name": judge["name"],
            "first_name": judge["firstName"],
            "last_name": judge["lastName"],
            "login": judge["login"],
            "password_hash": judge["passwordHash"],
            "role": judge["role"],
            "device_label": judge["deviceLabel"],
            "is_active": next_is_active,
            "created_at": judge["createdAt"],
            "updated_at": next_timestamp_after(judge["updatedAt"]),
        }
    )

    with db.transaction():
        db.execute(JUDGE_UPSERT_SQL, payload)
        record_event(db, "judge", payload["id"], "upsert", payload, get_node_id(db))

    return get_judge_by_id(db, judge_id)


def delete_judge(db: Database, judge_id: str) -> dict:
    judge = get_judge_by_id(db, judge_id)

    if judge is None:
        raise ValueError("Juge introuvable")

    score_count = db.query_one("SELECT COUNT(*) AS count FROM scores WHERE judge_id = ?", (judge_id,))["count"]

    if score_count > 0:
        competitions = db.query_all(
            """
            SELECT DISTINCT c.name AS name
            FROM scores s
            INNER JOIN competitions c ON c.id = s.competition_id
            WHERE s.judge_id = ?
            ORDER BY c.event_date DESC, c.name ASC
            """,
            (judge_id,),
        )
        competition_names = [str(row["name"] or "").strip() for row in competitions if str(row["name"] or "").strip()]

        if competition_names:
            raise ValueError(
                f"Impossible de supprimer ce juge: il a déjà noté dans {' / '.join(competition_names)}"
            )

        raise ValueError("Impossible de supprimer ce juge: il a déjà été utilisé dans des notes")

    with db.transaction():
        delete_entity(db, "judge", judge_id)
        record_event(db, "judge", judge_id, "delete", {"id": judge_id, "updated_at": now()}, get_node_id(db))

    return {"deletedJudgeId": judge_id}


def clear_judge_presence(db: Database, *, competition_id: str, judge_id: str) -> dict:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_judge_id = str(judge_id or "").strip()

    if not normalized_competition_id or not normalized_judge_id:
        raise ValueError("Compétition ou juge invalide")

    db.execute(
        "DELETE FROM judge_presence WHERE competition_id = ? AND judge_id = ?",
        (normalized_competition_id, normalized_judge_id),
    )

    return {"competitionId": normalized_competition_id, "judgeId": normalized_judge_id, "cleared": True}
