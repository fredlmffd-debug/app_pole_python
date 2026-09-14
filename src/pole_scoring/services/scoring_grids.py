"""Sous-ensemble minimal du moteur de grilles de notation (app_pole/src/db.js),
juste ce qu'il faut pour que la creation d'une competition puisse lui
attribuer une version active de chaque grille par defaut. Le reste (CRUD des
grilles/criteres, versioning complet) sera porte en Phase 3."""

from __future__ import annotations

from ..db.connection import Database
from ..utils.ids import new_id
from ..utils.time import now, next_timestamp_after

SCORING_GRID_KEYS = [
    "artistic_solo",
    "artistic_duo",
    "technical_solo",
    "technical_duo",
]

DEFAULT_SCORING_GRIDS = [
    {
        "key": "artistic_solo",
        "label": "Artistique · Solo",
        "sector": "artistique",
        "division": "solo",
        "score_min": 0,
        "score_max": 5,
        "score_step": 0.5,
        "criteria": [
            "Danse, grâce & fluidité",
            "Chorégraphie & musicalité",
            "Floor work (non debout)",
            "Expression artistique, créativité, originalité",
            "Présentation générale, rapport au public, assurance",
            "Cohérence thème-personnage / musique-costume",
        ],
    },
    {
        "key": "artistic_duo",
        "label": "Artistique · Duo",
        "sector": "artistique",
        "division": "duo",
        "score_min": 0,
        "score_max": 5,
        "score_step": 0.5,
        "criteria": [
            "Danse, grâce & fluidité",
            "Chorégraphie & musicalité",
            "Floor work (non debout)",
            "Expression artistique, créativité, originalité. Connexion au partenaire",
            "Présentation générale, rapport au public, assurance",
            "Cohérence thème-personnage / musique-costume",
        ],
    },
    {
        "key": "technical_solo",
        "label": "Technique · Solo",
        "sector": "technique",
        "division": "solo",
        "score_min": 0,
        "score_max": 5,
        "score_step": 0.5,
        "criteria": [
            "Figures basées sur la souplesse",
            "Figures basées sur la force",
            "Mouvements dynamiques",
            "Précision et propreté du mouvement",
            "Fluidité et transitions",
            "Originalité des mouvements et combos",
        ],
    },
    {
        "key": "technical_duo",
        "label": "Technique · Duo",
        "sector": "technique",
        "division": "duo",
        "score_min": 0,
        "score_max": 5,
        "score_step": 0.5,
        "criteria": [
            "Figures basées sur la souplesse",
            "Figures basées sur la force",
            "Mouvements dynamiques",
            "Précision et propreté du mouvement / Synchronicité avec le partenaire",
            "Fluidité et transitions",
            "Originalité des mouvements et combos",
        ],
    },
]


def normalize_scoring_grid_key(value: str | None) -> str:
    normalized_value = str(value or "").strip().lower()
    return normalized_value if normalized_value in SCORING_GRID_KEYS else ""


def get_criterion_key_prefix(grid_key: str) -> str:
    return {
        "artistic_solo": "AS",
        "artistic_duo": "AD",
        "artistic_common": "AC",
        "technical_solo": "TS",
        "technical_duo": "TD",
        "technical_common": "TC",
    }.get(grid_key, "CR")


def build_criterion_key(grid_key: str, sort_order: int, version_number: int) -> str:
    safe_sort_order = max(1, int(sort_order or 1))
    safe_version_number = max(1, int(version_number or 1))
    return f"{get_criterion_key_prefix(grid_key)}{safe_sort_order}_v{safe_version_number}"


def get_scoring_grid_by_key(db: Database, grid_key: str) -> dict | None:
    return db.query_one(
        """
        SELECT id, grid_key AS gridKey, label, sector, division,
               created_at AS createdAt, updated_at AS updatedAt
        FROM scoring_grids
        WHERE grid_key = ?
        """,
        (grid_key,),
    )


def get_active_scoring_grid_version(db: Database, grid_key: str) -> dict | None:
    normalized_grid_key = normalize_scoring_grid_key(grid_key)

    if not normalized_grid_key:
        raise ValueError("Type de grille invalide")

    return db.query_one(
        """
        SELECT v.id, v.grid_id AS gridId, v.version_number AS versionNumber,
               v.is_active AS isActive, v.score_min AS scoreMin, v.score_max AS scoreMax,
               v.score_step AS scoreStep, v.created_at AS createdAt, v.updated_at AS updatedAt
        FROM scoring_grid_versions v
        INNER JOIN scoring_grids g ON g.id = v.grid_id
        WHERE g.grid_key = ? AND v.is_active = 1
        ORDER BY v.version_number DESC
        LIMIT 1
        """,
        (normalized_grid_key,),
    )


def get_scoring_profile_version_ids(db: Database) -> dict:
    profile = {
        "artistic_solo_grid_version_id": "",
        "artistic_duo_grid_version_id": "",
        "technical_solo_grid_version_id": "",
        "technical_duo_grid_version_id": "",
    }

    for grid_key in SCORING_GRID_KEYS:
        active_version = get_active_scoring_grid_version(db, grid_key)

        if not active_version:
            raise ValueError(f"Aucune version active pour la grille {grid_key}")

        profile[f"{grid_key}_grid_version_id"] = active_version["id"]

    return profile


def ensure_default_scoring_grid(db: Database, seed: dict) -> None:
    timestamp = now()
    grid = get_scoring_grid_by_key(db, seed["key"])

    if grid is None:
        db.execute(
            """
            INSERT INTO scoring_grids (id, grid_key, label, sector, division, created_at, updated_at)
            VALUES (:id, :grid_key, :label, :sector, :division, :created_at, :updated_at)
            """,
            {
                "id": new_id(),
                "grid_key": seed["key"],
                "label": seed["label"],
                "sector": seed["sector"],
                "division": seed["division"],
                "created_at": timestamp,
                "updated_at": timestamp,
            },
        )
        grid = get_scoring_grid_by_key(db, seed["key"])

    has_version = db.query_one(
        "SELECT 1 AS found FROM scoring_grid_versions WHERE grid_id = ? LIMIT 1", (grid["id"],)
    )

    if has_version:
        return

    version_id = new_id()
    version_number = 1
    db.execute(
        """
        INSERT INTO scoring_grid_versions
            (id, grid_id, version_number, is_active, score_min, score_max, score_step, created_at, updated_at)
        VALUES (:id, :grid_id, :version_number, 1, :score_min, :score_max, :score_step, :created_at, :updated_at)
        """,
        {
            "id": version_id,
            "grid_id": grid["id"],
            "version_number": version_number,
            "score_min": seed["score_min"],
            "score_max": seed["score_max"],
            "score_step": seed["score_step"],
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )

    criterion_timestamp = timestamp
    for index, label in enumerate(seed["criteria"]):
        criterion_timestamp = next_timestamp_after(criterion_timestamp)
        db.execute(
            """
            INSERT INTO scoring_grid_criteria
                (id, grid_version_id, criterion_key, label, sort_order, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                new_id(),
                version_id,
                build_criterion_key(seed["key"], index + 1, version_number),
                str(label),
                index + 1,
                criterion_timestamp,
                criterion_timestamp,
            ),
        )


def ensure_default_scoring_grids(db: Database) -> None:
    for seed in DEFAULT_SCORING_GRIDS:
        ensure_default_scoring_grid(db, seed)

    profile = get_scoring_profile_version_ids(db)

    db.execute(
        """
        UPDATE competitions
        SET artistic_solo_grid_version_id = COALESCE(NULLIF(artistic_solo_grid_version_id, ''), ?),
            artistic_duo_grid_version_id = COALESCE(NULLIF(artistic_duo_grid_version_id, ''), ?),
            technical_solo_grid_version_id = COALESCE(NULLIF(technical_solo_grid_version_id, ''), ?),
            technical_duo_grid_version_id = COALESCE(NULLIF(technical_duo_grid_version_id, ''), ?)
        WHERE COALESCE(artistic_solo_grid_version_id, '') = ''
           OR COALESCE(artistic_duo_grid_version_id, '') = ''
           OR COALESCE(technical_solo_grid_version_id, '') = ''
           OR COALESCE(technical_duo_grid_version_id, '') = ''
        """,
        (
            profile["artistic_solo_grid_version_id"],
            profile["artistic_duo_grid_version_id"],
            profile["technical_solo_grid_version_id"],
            profile["technical_duo_grid_version_id"],
        ),
    )
