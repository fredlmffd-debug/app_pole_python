from __future__ import annotations

import re
from datetime import date

from ..db.connection import Database
from ..db.events import record_event, delete_entity
from ..db.settings import get_node_id
from ..utils.ids import new_id
from ..utils.security import hash_competition_delete_password
from ..utils.text import normalize_identity_name
from ..utils.time import next_timestamp_after, now
from ..utils.validation import parse_int_like_js
from .scoring_grids import get_scoring_profile_version_ids

COMPETITION_LEVELS = {"defi", "regional", "national"}

REGION_TO_ZONE = {
    "Sud-Est": "Sud",
    "Sud-Ouest": "Sud",
    "Nord-Est": "Nord",
    "Nord-Ouest": "Nord",
    "Antilles-Guyane": "Outre-Mer",
    "Reunion-Tahiti": "Outre-Mer",
}

COMPETITION_UPSERT_SQL = """
INSERT INTO competitions (
  id, name, location, event_date, season, competition_level, region, zone,
  judge_count, scrutateur_name, delete_password_hash,
  artistic_solo_grid_version_id, artistic_duo_grid_version_id,
  technical_solo_grid_version_id, technical_duo_grid_version_id,
  status, created_at, updated_at
)
VALUES (
  :id, :name, :location, :event_date, :season, :competition_level, :region, :zone,
  :judge_count, :scrutateur_name, :delete_password_hash,
  :artistic_solo_grid_version_id, :artistic_duo_grid_version_id,
  :technical_solo_grid_version_id, :technical_duo_grid_version_id,
  :status, :created_at, :updated_at
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  location = excluded.location,
  event_date = excluded.event_date,
  season = excluded.season,
  competition_level = excluded.competition_level,
  region = excluded.region,
  zone = excluded.zone,
  judge_count = excluded.judge_count,
  scrutateur_name = excluded.scrutateur_name,
  delete_password_hash = excluded.delete_password_hash,
  artistic_solo_grid_version_id = excluded.artistic_solo_grid_version_id,
  artistic_duo_grid_version_id = excluded.artistic_duo_grid_version_id,
  technical_solo_grid_version_id = excluded.technical_solo_grid_version_id,
  technical_duo_grid_version_id = excluded.technical_duo_grid_version_id,
  status = excluded.status,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > competitions.updated_at
"""


def _format_season(start_year: int) -> str:
    return f"{start_year}/{start_year + 1}"


def _season_from_event_date(value: str | None) -> str:
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(value or ""))

    if not match:
        today = date.today()
        current_start_year = today.year if today.month >= 9 else today.year - 1
        return _format_season(current_start_year)

    year = int(match.group(1))
    month = int(match.group(2))
    return _format_season(year if month >= 9 else year - 1)


def normalize_season(value: str | None, event_date: str = "") -> str:
    raw_value = re.sub(r"\s+", "", re.sub(r"^saison\s+", "", str(value or "").strip(), flags=re.IGNORECASE))
    match = re.match(r"^(\d{4})/(\d{4})$", raw_value)

    if match and int(match.group(2)) == int(match.group(1)) + 1:
        return f"{match.group(1)}/{match.group(2)}"

    return _season_from_event_date(event_date)


def normalize_competition_level(value: str | None) -> str:
    normalized_value = str(value or "").strip().lower()
    return normalized_value if normalized_value in COMPETITION_LEVELS else "defi"


def normalize_competition_territory(level: str, region: str | None, zone: str | None) -> dict:
    if level != "regional":
        return {"region": "", "zone": ""}

    normalized_region = str(region or "").strip()
    computed_zone = REGION_TO_ZONE.get(normalized_region, str(zone or "").strip())

    if not normalized_region or not computed_zone:
        raise ValueError("La région est obligatoire pour une compétition régionale")

    return {"region": normalized_region, "zone": computed_zone}


def normalize_judge_count(value: object, fallback_value: int = 3) -> int:
    normalized_fallback = min(max(int(fallback_value), 1), 20) if isinstance(fallback_value, int) else 3
    parsed_value = parse_int_like_js(value)

    if parsed_value is None:
        return normalized_fallback

    return min(max(parsed_value, 1), 20)


def normalize_competition_payload(payload: dict) -> dict:
    """Normalisation generique d'une ligne competition brute (utilisee par le
    dispatch apply_entity de la synchronisation inter-poste, cf. Phase 5) :
    accepte indifferemment les cles snake_case et camelCase."""
    event_date = str(payload.get("event_date") or payload.get("eventDate") or "").strip()
    competition_level = normalize_competition_level(payload.get("competition_level") or payload.get("competitionLevel"))
    territory = normalize_competition_territory(competition_level, payload.get("region"), payload.get("zone"))

    return {
        **payload,
        "event_date": event_date,
        "season": normalize_season(payload.get("season"), event_date),
        "competition_level": competition_level,
        "region": territory["region"],
        "zone": territory["zone"],
        "judge_count": normalize_judge_count(payload.get("judge_count") or payload.get("judgeCount")),
        "scrutateur_name": str(payload.get("scrutateur_name") or payload.get("scrutateurName") or "").strip(),
        "delete_password_hash": str(
            payload.get("delete_password_hash") or payload.get("deletePasswordHash") or ""
        ).strip(),
    }


def normalize_competition_identity_name(value: str | None) -> str:
    return normalize_identity_name(value)


def assert_competition_identity_available(
    db: Database, name: str, event_date: str, excluded_competition_id: str = ""
) -> None:
    target_name = normalize_competition_identity_name(name)
    target_event_date = str(event_date or "").strip()

    if not target_name or not target_event_date:
        return

    candidates = db.query_all(
        "SELECT id, name FROM competitions WHERE event_date = ?", (target_event_date,)
    )

    for competition in candidates:
        if (
            competition["id"] != excluded_competition_id
            and normalize_competition_identity_name(competition["name"]) == target_name
        ):
            raise ValueError("Une compétition portant ce nom existe déjà à cette date")


def get_competition_delete_password_hash(db: Database, competition_id: str) -> str:
    row = db.query_one(
        "SELECT COALESCE(delete_password_hash, '') AS deletePasswordHash FROM competitions WHERE id = ?",
        (competition_id,),
    )
    return row["deletePasswordHash"] if row else ""


def has_competition_delete_password(db: Database, competition_id: str) -> bool:
    return bool(get_competition_delete_password_hash(db, competition_id))


def verify_competition_delete_password(db: Database, competition_id: str, password: str) -> bool:
    stored_hash = get_competition_delete_password_hash(db, competition_id)

    if not stored_hash:
        return False

    return stored_hash == hash_competition_delete_password(password)


COMPETITION_ROW_SELECT = """
SELECT id,
       name,
       location,
       event_date AS eventDate,
       season,
       competition_level AS competitionLevel,
       region,
       zone,
       judge_count AS judgeCount,
       COALESCE(scrutateur_name, '') AS scrutateurName,
       COALESCE(delete_password_hash, '') <> '' AS hasDeletionPassword,
       COALESCE(artistic_solo_grid_version_id, '') AS artisticSoloGridVersionId,
       COALESCE(artistic_duo_grid_version_id, '') AS artisticDuoGridVersionId,
       COALESCE(technical_solo_grid_version_id, '') AS technicalSoloGridVersionId,
       COALESCE(technical_duo_grid_version_id, '') AS technicalDuoGridVersionId,
       status,
       created_at AS createdAt,
       updated_at AS updatedAt
FROM competitions
WHERE id = ?
"""


def get_competition_row_by_id(db: Database, competition_id: str) -> dict | None:
    return db.query_one(COMPETITION_ROW_SELECT, (competition_id,))


def list_competitions(db: Database) -> list[dict]:
    return db.query_all(
        """
        SELECT id,
               name,
               location,
               event_date AS eventDate,
               season,
               competition_level AS competitionLevel,
               region,
               zone,
               judge_count AS judgeCount,
               COALESCE(scrutateur_name, '') AS scrutateurName,
               COALESCE(delete_password_hash, '') <> '' AS hasDeletionPassword,
               COALESCE(artistic_solo_grid_version_id, '') AS artisticSoloGridVersionId,
               COALESCE(artistic_duo_grid_version_id, '') AS artisticDuoGridVersionId,
               COALESCE(technical_solo_grid_version_id, '') AS technicalSoloGridVersionId,
               COALESCE(technical_duo_grid_version_id, '') AS technicalDuoGridVersionId,
               (
                 COALESCE(TRIM(name), '') <> ''
                 AND COALESCE(TRIM(event_date), '') <> ''
                 AND COALESCE(TRIM(season), '') <> ''
                 AND COALESCE(TRIM(competition_level), '') <> ''
                 AND COALESCE(judge_count, 0) > 0
                 AND (
                   competition_level <> 'regional'
                   OR (
                     COALESCE(TRIM(region), '') <> ''
                     AND COALESCE(TRIM(zone), '') <> ''
                   )
                 )
               ) AS hasGeneralInfo,
               (
                 SELECT COUNT(*)
                 FROM judge_competition_assignments a
                 WHERE a.competition_id = competitions.id
                   AND COALESCE(TRIM(a.judge_role), '') <> ''
                   AND COALESCE(TRIM(a.judge_id), '') <> ''
               ) = COALESCE(judge_count, 0) AS hasCompleteJudgeAssignments,
               EXISTS(
                 SELECT 1
                 FROM competitors c
                 WHERE c.competition_id = competitions.id
               ) AS hasCompetitors,
               (
                 status = 'draft'
                 AND (
                   COALESCE(TRIM(name), '') <> ''
                   AND COALESCE(TRIM(event_date), '') <> ''
                   AND COALESCE(TRIM(season), '') <> ''
                   AND COALESCE(TRIM(competition_level), '') <> ''
                   AND COALESCE(judge_count, 0) > 0
                   AND (
                     competition_level <> 'regional'
                     OR (
                       COALESCE(TRIM(region), '') <> ''
                       AND COALESCE(TRIM(zone), '') <> ''
                     )
                   )
                 )
                 AND (
                   SELECT COUNT(*)
                   FROM judge_competition_assignments a
                   WHERE a.competition_id = competitions.id
                     AND COALESCE(TRIM(a.judge_role), '') <> ''
                     AND COALESCE(TRIM(a.judge_id), '') <> ''
                 ) = COALESCE(judge_count, 0)
                 AND EXISTS(
                   SELECT 1
                   FROM competitors c
                   WHERE c.competition_id = competitions.id
                 )
               ) AS canGenerateJudgeSheets,
               EXISTS(
                 SELECT 1
                 FROM judge_competition_assignments a
                 WHERE a.competition_id = competitions.id
                   AND COALESCE(a.is_trainee, 0) = 1
                   AND COALESCE(TRIM(a.judge_id), '') <> ''
               ) AS hasShadowJudges,
               EXISTS(
                 SELECT 1
                 FROM scores s
                 WHERE s.competition_id = competitions.id
               ) AS hasResults,
               status,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM competitions
        ORDER BY CAST(SUBSTR(COALESCE(season, '0000/0001'), 1, 4) AS INTEGER) DESC,
                 event_date DESC,
                 created_at DESC
        """
    )


def _upsert_competition(db: Database, competition_row: dict) -> None:
    assert_competition_identity_available(
        db, competition_row["name"], competition_row["event_date"], competition_row["id"]
    )
    db.execute(COMPETITION_UPSERT_SQL, competition_row)


def create_competition(
    db: Database,
    *,
    name: str,
    location: str = "",
    event_date: str = "",
    season: str = "",
    competition_level: str = "defi",
    region: str = "",
    zone: str = "",
    judge_count: object = 3,
    scrutateur_name: str = "",
    delete_password: str = "",
    status: str = "draft",
) -> dict:
    normalized_level = normalize_competition_level(competition_level)
    territory = normalize_competition_territory(normalized_level, region, zone)
    timestamp = now()
    scoring_profile_version_ids = get_scoring_profile_version_ids(db)

    competition_row = {
        "id": new_id(),
        "name": name,
        "location": location,
        "event_date": event_date,
        "season": normalize_season(season, event_date),
        "competition_level": normalized_level,
        "region": territory["region"],
        "zone": territory["zone"],
        "judge_count": normalize_judge_count(judge_count),
        "scrutateur_name": str(scrutateur_name or "").strip(),
        "delete_password_hash": hash_competition_delete_password(delete_password),
        "status": status,
        "created_at": timestamp,
        "updated_at": timestamp,
        **scoring_profile_version_ids,
    }

    with db.transaction():
        _upsert_competition(db, competition_row)
        record_event(db, "competition", competition_row["id"], "upsert", competition_row, get_node_id(db))

    return get_competition_row_by_id(db, competition_row["id"])


def update_competition(
    db: Database,
    *,
    competition_id: str,
    name: str,
    location: str = "",
    event_date: str = "",
    season: str = "",
    competition_level: str = "defi",
    region: str = "",
    zone: str = "",
    judge_count: object = 3,
    scrutateur_name: str | None = None,
    delete_password: str | None = None,
    status: str = "draft",
) -> dict:
    existing_competition = get_competition_row_by_id(db, competition_id)

    if existing_competition is None:
        raise ValueError("Compétition introuvable")

    normalized_level = normalize_competition_level(competition_level)
    territory = normalize_competition_territory(normalized_level, region, zone)
    updated_at = next_timestamp_after(existing_competition["updatedAt"])

    if status == "active" and existing_competition["status"] != "active":
        already_active = db.query_one(
            "SELECT id FROM competitions WHERE status = 'active' AND id != ?", (competition_id,)
        )

        if already_active:
            raise ValueError(
                "Une compétition est déjà active. Clôturez-la avant d'en activer une nouvelle."
            )

    competition_row = {
        "id": existing_competition["id"],
        "name": name,
        "location": location,
        "event_date": event_date,
        "season": normalize_season(season, event_date),
        "competition_level": normalized_level,
        "region": territory["region"],
        "zone": territory["zone"],
        "judge_count": normalize_judge_count(judge_count, existing_competition["judgeCount"]),
        "scrutateur_name": str(
            scrutateur_name if scrutateur_name is not None else existing_competition["scrutateurName"] or ""
        ).strip(),
        "delete_password_hash": (
            hash_competition_delete_password(delete_password)
            if isinstance(delete_password, str) and delete_password.strip()
            else get_competition_delete_password_hash(db, competition_id)
        ),
        "artistic_solo_grid_version_id": existing_competition["artisticSoloGridVersionId"],
        "artistic_duo_grid_version_id": existing_competition["artisticDuoGridVersionId"],
        "technical_solo_grid_version_id": existing_competition["technicalSoloGridVersionId"],
        "technical_duo_grid_version_id": existing_competition["technicalDuoGridVersionId"],
        "status": status,
        "created_at": existing_competition["createdAt"],
        "updated_at": updated_at,
    }

    with db.transaction():
        _upsert_competition(db, competition_row)
        db.execute(
            "DELETE FROM judge_competition_assignments WHERE competition_id = ? AND slot_index > ?",
            (competition_id, competition_row["judge_count"]),
        )
        record_event(db, "competition", competition_row["id"], "upsert", competition_row, get_node_id(db))

    return get_competition_row_by_id(db, competition_id)


def get_active_competition_for_dashboard(db: Database) -> dict | None:
    return db.query_one(
        """
        SELECT id, name, location, event_date AS eventDate, season, competition_level AS competitionLevel,
               region, zone, judge_count AS judgeCount, COALESCE(scrutateur_name, '') AS scrutateurName, status
        FROM competitions
        WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
        """
    )


def delete_competition(db: Database, competition_id: str) -> dict:
    competition = get_competition_row_by_id(db, competition_id)

    if competition is None:
        raise ValueError("Compétition introuvable")

    with db.transaction():
        delete_entity(db, "competition", competition_id)
        record_event(
            db, "competition", competition_id, "delete", {"id": competition_id, "updated_at": now()}, get_node_id(db)
        )

    return {"deletedCompetitionId": competition_id}
