from __future__ import annotations

import re

from ..db.connection import Database
from ..db.events import record_event, delete_entity
from ..db.settings import get_node_id
from ..utils.ids import new_id
from ..utils.text import normalize_ascii_lower, normalize_identity_name, strip_accents
from ..utils.time import next_timestamp_after, now

COMPETITOR_MEMBER_SEPARATOR = " / "
COMPETITOR_STATUSES = {"registered", "withdrawn", "forfeit", "disqualified"}

COMPETITOR_UPSERT_SQL = """
INSERT INTO competitors (
  id, competition_id, stage_name, first_name, last_name, category, running_order,
  is_resident, status, created_at, updated_at
)
VALUES (
  :id, :competition_id, :stage_name, :first_name, :last_name, :category, :running_order,
  :is_resident, :status, :created_at, :updated_at
)
ON CONFLICT(id) DO UPDATE SET
  competition_id = excluded.competition_id,
  stage_name = excluded.stage_name,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  category = excluded.category,
  running_order = excluded.running_order,
  is_resident = excluded.is_resident,
  status = excluded.status,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > competitors.updated_at
"""

RESIDENT_KEYWORDS = {"true", "yes", "oui", "resident", "resid"}
RESIDENT_KEYWORDS_WITH_SHORTHAND = RESIDENT_KEYWORDS | {"r"}


def parse_resident_flag(value: object) -> bool:
    """Equivalent de parseResidentFlag (server.js) : accepte un large eventail
    de saisies libres (case a cocher, texte importe depuis Excel...)."""
    if value is True or value in (1, "1"):
        return True

    return normalize_ascii_lower(value) in RESIDENT_KEYWORDS_WITH_SHORTHAND


def normalize_competitor_resident_flag(value: object) -> int:
    if value is True or value in (1, "1"):
        return 1

    return 1 if normalize_ascii_lower(value) in RESIDENT_KEYWORDS else 0


def normalize_athlete_name_part(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def normalize_athlete_birth_date(value: str | None) -> str:
    raw_value = str(value or "").strip()

    if not raw_value:
        return ""

    iso_match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", raw_value)

    if iso_match:
        return f"{iso_match.group(1)}-{iso_match.group(2)}-{iso_match.group(3)}"

    french_match = re.match(r"^(\d{2})[/-](\d{2})[/-](\d{4})$", raw_value)

    if french_match:
        return f"{french_match.group(3)}-{french_match.group(2)}-{french_match.group(1)}"

    return raw_value


def normalize_athlete_identity_value(value: str | None) -> str:
    return strip_accents(normalize_athlete_name_part(value)).lower()


def build_athlete_identity_key(first_name: str = "", last_name: str = "", birth_date: str = "") -> str:
    normalized_first_name = normalize_athlete_identity_value(first_name)
    normalized_last_name = normalize_athlete_identity_value(last_name)
    normalized_birth_date = normalize_athlete_birth_date(birth_date)

    if not normalized_first_name or not normalized_last_name or not normalized_birth_date:
        return ""

    return f"{normalized_last_name}::{normalized_first_name}::{normalized_birth_date}"


def _split_member_values(value: str | None) -> list[str]:
    return [part.strip() for part in str(value or "").split("/") if part.strip()]


def normalize_competitor_members(payload: dict) -> list[dict]:
    explicit_members = payload.get("members")
    if not isinstance(explicit_members, list):
        explicit_members = payload.get("memberAthletes")
    if not isinstance(explicit_members, list):
        explicit_members = None

    if explicit_members is not None:
        raw_members = explicit_members
    else:
        first_names = _split_member_values(payload.get("first_name") or payload.get("firstName"))
        last_names = _split_member_values(payload.get("last_name") or payload.get("lastName"))
        birth_dates = _split_member_values(payload.get("birth_date") or payload.get("birthDate"))
        member_count = max(len(first_names), len(last_names), len(birth_dates))
        raw_members = [
            {
                "firstName": first_names[index] if index < len(first_names) else "",
                "lastName": last_names[index] if index < len(last_names) else "",
                "birthDate": birth_dates[index] if index < len(birth_dates) else "",
            }
            for index in range(member_count)
        ]

    members = []
    for index, member in enumerate(raw_members):
        member = member or {}
        try:
            member_order = int(member.get("memberOrder", member.get("member_order", index + 1)))
        except (TypeError, ValueError):
            member_order = index + 1

        normalized_member = {
            "memberOrder": member_order or index + 1,
            "firstName": normalize_athlete_name_part(member.get("firstName") or member.get("first_name")),
            "lastName": normalize_athlete_name_part(member.get("lastName") or member.get("last_name")),
            "birthDate": normalize_athlete_birth_date(member.get("birthDate") or member.get("birth_date")),
            "isResident": normalize_competitor_resident_flag(
                member.get("isResident", member.get("is_resident"))
            )
            == 1,
        }

        if normalized_member["firstName"] or normalized_member["lastName"] or normalized_member["birthDate"]:
            members.append(normalized_member)

    members.sort(key=lambda member: member["memberOrder"])
    return members


def build_competitor_member_label(member: dict) -> str:
    return " ".join(part for part in (member.get("lastName"), member.get("firstName")) if part).strip()


def build_competitor_stage_name_from_members(members: list[dict], fallback_name: str = "") -> str:
    labels = [label for label in (build_competitor_member_label(member) for member in members) if label]
    return " & ".join(labels) if labels else str(fallback_name or "").strip()


def build_competitor_joined_member_field(members: list[dict], field_name: str) -> str:
    return COMPETITOR_MEMBER_SEPARATOR.join(
        value for value in (member.get(field_name) for member in members) if value
    )


def normalize_competitor_status(value: str | None) -> str:
    normalized_value = str(value or "").strip().lower()
    return normalized_value if normalized_value in COMPETITOR_STATUSES else "registered"


def build_competitor_stage_name(first_name: str, last_name: str, fallback_name: str = "") -> str:
    full_name = " ".join(part for part in (str(last_name or "").strip(), str(first_name or "").strip()) if part)
    return full_name or str(fallback_name or "").strip()


def normalize_competitor_payload(payload: dict) -> dict:
    payload = dict(payload)
    payload.pop("birth_date", None)
    payload.pop("birthDate", None)

    members = normalize_competitor_members(payload)
    first_name = build_competitor_joined_member_field(members, "firstName") or str(
        payload.get("first_name") or payload.get("firstName") or ""
    ).strip()
    last_name = build_competitor_joined_member_field(members, "lastName") or str(
        payload.get("last_name") or payload.get("lastName") or ""
    ).strip()
    members_resident_flag = (
        1
        if any(
            normalize_competitor_resident_flag(member.get("isResident", member.get("is_resident"))) == 1
            for member in members
        )
        else 0
    )
    stage_name = (
        build_competitor_stage_name_from_members(members, payload.get("stage_name") or payload.get("stageName"))
        if members
        else build_competitor_stage_name(first_name, last_name, payload.get("stage_name") or payload.get("stageName"))
    )

    try:
        running_order = int(str(payload.get("running_order", payload.get("runningOrder", ""))).strip())
    except (TypeError, ValueError):
        running_order = None

    return {
        **payload,
        "stage_name": stage_name,
        "first_name": first_name,
        "last_name": last_name or stage_name,
        "category": str(payload.get("category") or "").strip(),
        "running_order": running_order,
        "is_resident": members_resident_flag or normalize_competitor_resident_flag(
            payload.get("is_resident", payload.get("isResident"))
        ),
        "status": normalize_competitor_status(payload.get("status")),
        "members": members,
    }


def normalize_competitor_identity_name(value: str | None) -> str:
    return normalize_identity_name(value)


def assert_competitor_available(db: Database, competition_id: str, stage_name: str, running_order: object) -> None:
    target_name = normalize_competitor_identity_name(stage_name)

    try:
        target_running_order = float(running_order)
    except (TypeError, ValueError):
        return

    if not target_name:
        return

    candidates = db.query_all(
        "SELECT stage_name AS stageName FROM competitors WHERE competition_id = ? AND running_order = ?",
        (competition_id, target_running_order),
    )

    for competitor in candidates:
        if normalize_competitor_identity_name(competitor["stageName"]) == target_name:
            raise ValueError("Ce compétiteur existe déjà avec le même ordre de passage")


# --- Resolution des athletes (deduplication inter-competitions) ---------


def get_stored_competitor_members(db: Database, competitor_id: str) -> list[dict]:
    return db.query_all(
        """
        SELECT m.member_order AS memberOrder,
               a.id AS athleteId,
               a.first_name AS firstName,
               a.last_name AS lastName,
               a.birth_date AS birthDate,
               a.identity_key AS identityKey
        FROM competitor_members m
        INNER JOIN athletes a ON a.id = m.athlete_id
        WHERE m.competitor_id = ?
        ORDER BY m.member_order ASC
        """,
        (competitor_id,),
    )


def find_existing_athlete_by_identity_key(db: Database, identity_key: str) -> dict | None:
    if not identity_key:
        return None

    return db.query_one(
        """
        SELECT id, first_name AS firstName, last_name AS lastName, birth_date AS birthDate,
               identity_key AS identityKey, created_at AS createdAt, updated_at AS updatedAt
        FROM athletes
        WHERE identity_key = ?
        """,
        (identity_key,),
    )


def create_athlete_record(db: Database, member: dict, reference_timestamp: str = "") -> dict:
    timestamp = next_timestamp_after(reference_timestamp)
    identity_key = build_athlete_identity_key(member["firstName"], member["lastName"], member["birthDate"])
    athlete_id = new_id()

    db.execute(
        """
        INSERT INTO athletes (id, first_name, last_name, birth_date, identity_key, created_at, updated_at)
        VALUES (:id, :first_name, :last_name, :birth_date, :identity_key, :created_at, :updated_at)
        """,
        {
            "id": athlete_id,
            "first_name": member["firstName"],
            "last_name": member["lastName"],
            "birth_date": member["birthDate"],
            "identity_key": identity_key,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )

    return {
        "id": athlete_id,
        "firstName": member["firstName"],
        "lastName": member["lastName"],
        "birthDate": member["birthDate"],
        "identityKey": identity_key,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def resolve_athlete_for_competitor_member(
    db: Database, member: dict, existing_members: list[dict], reference_timestamp: str = ""
) -> dict:
    identity_key = build_athlete_identity_key(member["firstName"], member["lastName"], member["birthDate"])

    if identity_key:
        existing_athlete = find_existing_athlete_by_identity_key(db, identity_key)

        if existing_athlete:
            return existing_athlete

    existing_member = next(
        (item for item in existing_members if item["memberOrder"] == member["memberOrder"]), None
    )

    if (
        existing_member
        and normalize_athlete_identity_value(existing_member["firstName"])
        == normalize_athlete_identity_value(member["firstName"])
        and normalize_athlete_identity_value(existing_member["lastName"])
        == normalize_athlete_identity_value(member["lastName"])
        and normalize_athlete_birth_date(existing_member["birthDate"])
        == normalize_athlete_birth_date(member["birthDate"])
    ):
        return {
            "id": existing_member["athleteId"],
            "firstName": existing_member["firstName"],
            "lastName": existing_member["lastName"],
            "birthDate": existing_member["birthDate"],
            "identityKey": existing_member.get("identityKey")
            or build_athlete_identity_key(
                existing_member["firstName"], existing_member["lastName"], existing_member["birthDate"]
            ),
        }

    return create_athlete_record(db, member, reference_timestamp)


def sync_competitor_members(db: Database, competitor_payload: dict) -> None:
    members = competitor_payload.get("members") or []
    existing_members = get_stored_competitor_members(db, competitor_payload["id"])
    last_timestamp = str(competitor_payload.get("updated_at") or competitor_payload.get("updatedAt") or now())

    db.execute("DELETE FROM competitor_members WHERE competitor_id = ?", (competitor_payload["id"],))

    for member in members:
        athlete = resolve_athlete_for_competitor_member(db, member, existing_members, last_timestamp)
        last_timestamp = next_timestamp_after(last_timestamp)
        db.execute(
            """
            INSERT INTO competitor_members (competitor_id, athlete_id, member_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (competitor_payload["id"], athlete["id"], member["memberOrder"], last_timestamp, last_timestamp),
        )


def list_competitor_members_by_competitor_ids(db: Database, competitor_ids: list[str]) -> dict[str, list[dict]]:
    if not competitor_ids:
        return {}

    placeholders = ", ".join("?" for _ in competitor_ids)
    rows = db.query_all(
        f"""
        SELECT m.competitor_id AS competitorId,
               m.member_order AS memberOrder,
               a.id AS athleteId,
               a.first_name AS firstName,
               a.last_name AS lastName,
               a.birth_date AS birthDate
        FROM competitor_members m
        INNER JOIN athletes a ON a.id = m.athlete_id
        WHERE m.competitor_id IN ({placeholders})
        ORDER BY m.competitor_id ASC, m.member_order ASC
        """,
        tuple(competitor_ids),
    )

    members_by_competitor_id: dict[str, list[dict]] = {}
    for row in rows:
        members_by_competitor_id.setdefault(row["competitorId"], []).append(
            {
                "athleteId": row["athleteId"],
                "memberOrder": row["memberOrder"],
                "firstName": row["firstName"],
                "lastName": row["lastName"],
                "birthDate": row["birthDate"],
            }
        )

    return members_by_competitor_id


def hydrate_competitor_members(db: Database, competitors: list[dict]) -> list[dict]:
    members_by_competitor_id = list_competitor_members_by_competitor_ids(
        db, [competitor["id"] for competitor in competitors]
    )

    hydrated = []
    for competitor in competitors:
        members = members_by_competitor_id.get(competitor["id"], [])

        if not members:
            hydrated.append({**competitor, "members": normalize_competitor_members(competitor)})
            continue

        hydrated.append(
            {
                **competitor,
                "firstName": build_competitor_joined_member_field(members, "firstName") or competitor.get("firstName"),
                "lastName": build_competitor_joined_member_field(members, "lastName") or competitor.get("lastName"),
                "stageName": build_competitor_stage_name_from_members(members, competitor.get("stageName")),
                "members": members,
            }
        )

    return hydrated


# --- CRUD -----------------------------------------------------------------


def _upsert_competitor(db: Database, competitor_row: dict) -> None:
    sql_payload = {key: value for key, value in competitor_row.items() if key != "members"}
    db.execute(COMPETITOR_UPSERT_SQL, sql_payload)
    sync_competitor_members(db, competitor_row)


def add_competitor(
    db: Database,
    *,
    competition_id: str,
    stage_name: str = "",
    first_name: str = "",
    last_name: str = "",
    birth_date: str = "",
    members: list[dict] | None = None,
    category: str = "",
    running_order: object,
    is_resident: object = 0,
    status: str = "registered",
) -> dict:
    timestamp = now()
    normalized_competitor = normalize_competitor_payload(
        {
            "id": new_id(),
            "competition_id": competition_id,
            "stage_name": stage_name,
            "first_name": first_name,
            "last_name": last_name,
            "birth_date": birth_date,
            "members": members or [],
            "category": category,
            "running_order": running_order,
            "is_resident": is_resident,
            "status": status,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
    )

    assert_competitor_available(db, competition_id, normalized_competitor["stage_name"], normalized_competitor["running_order"])

    with db.transaction():
        _upsert_competitor(db, normalized_competitor)
        record_event(
            db, "competitor", normalized_competitor["id"], "upsert", normalized_competitor, get_node_id(db)
        )

    return normalized_competitor


def get_competitor_by_id(db: Database, competitor_id: str) -> dict | None:
    competitor = db.query_one(
        """
        SELECT c.id,
               c.competition_id AS competitionId,
               c.stage_name AS stageName,
               COALESCE(c.first_name, '') AS firstName,
               COALESCE(c.last_name, '') AS lastName,
               COALESCE(c.category, '') AS category,
               c.running_order AS runningOrder,
               COALESCE(c.is_resident, 0) AS isResident,
               COALESCE(c.status, 'registered') AS status,
               c.created_at AS createdAt,
               c.updated_at AS updatedAt,
               comp.name AS competitionName,
               comp.location,
               comp.event_date AS eventDate,
               comp.season,
               comp.competition_level AS competitionLevel,
               comp.region,
               comp.zone,
               comp.judge_count AS judgeCount,
               COALESCE(comp.scrutateur_name, '') AS scrutateurName
        FROM competitors c
        INNER JOIN competitions comp ON comp.id = c.competition_id
        WHERE c.id = ?
        """,
        (competitor_id,),
    )

    if competitor is None:
        return None

    return hydrate_competitor_members(db, [competitor])[0]


def update_competitor_status(db: Database, *, competitor_id: str, status: str) -> dict:
    existing_competitor = get_competitor_by_id(db, competitor_id)

    if existing_competitor is None:
        raise ValueError("Compétiteur introuvable")

    updated_competitor = normalize_competitor_payload(
        {
            "id": existing_competitor["id"],
            "competition_id": existing_competitor["competitionId"],
            "stage_name": existing_competitor["stageName"],
            "first_name": existing_competitor["firstName"],
            "last_name": existing_competitor["lastName"],
            "category": existing_competitor["category"],
            "running_order": existing_competitor["runningOrder"],
            "is_resident": existing_competitor["isResident"],
            "status": normalize_competitor_status(status),
            "created_at": existing_competitor["createdAt"],
            "updated_at": next_timestamp_after(existing_competitor["updatedAt"]),
        }
    )

    with db.transaction():
        _upsert_competitor(db, updated_competitor)
        record_event(db, "competitor", updated_competitor["id"], "upsert", updated_competitor, get_node_id(db))

    return get_competitor_by_id(db, competitor_id)


def list_competitors(db: Database, competition_id: str) -> list[dict]:
    competitors = db.query_all(
        """
        SELECT id,
               competition_id AS competitionId,
               stage_name AS stageName,
               COALESCE(first_name, '') AS firstName,
               COALESCE(last_name, '') AS lastName,
               COALESCE(category, '') AS category,
               running_order AS runningOrder,
               COALESCE(is_resident, 0) AS isResident,
               COALESCE(status, 'registered') AS status,
               created_at AS createdAt, updated_at AS updatedAt
        FROM competitors
        WHERE competition_id = ?
        ORDER BY running_order, last_name, first_name, stage_name
        """,
        (competition_id,),
    )

    return hydrate_competitor_members(db, competitors)


def replace_competition_competitors(db: Database, competition_id: str) -> dict:
    from .competitions import get_competition_row_by_id

    competition = get_competition_row_by_id(db, competition_id)

    if competition is None:
        raise ValueError("Compétition introuvable")

    if competition["status"] != "draft":
        raise ValueError("Le remplacement de liste est réservé aux compétitions en brouillon")

    competitors = list_competitors(db, competition_id)
    node_id = get_node_id(db)

    with db.transaction():
        for competitor in competitors:
            delete_entity(db, "competitor", competitor["id"])
            record_event(
                db, "competitor", competitor["id"], "delete", {"id": competitor["id"], "updated_at": now()}, node_id
            )

    return {"deletedCompetitorCount": len(competitors)}
