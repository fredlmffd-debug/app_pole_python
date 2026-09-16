"""Moteur de grilles de notation, porte depuis app_pole/src/db.js : grilles
par defaut (Phase 2), CRUD complet des versions/criteres et profil de
notation d'une competition (Phase 3)."""

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


# --- CRUD complet (Phase 3) ------------------------------------------------


def normalize_score_range(score_min: object, score_max: object, score_step: object) -> dict:
    try:
        parsed_min = float(score_min)
    except (TypeError, ValueError):
        parsed_min = 0.0

    try:
        parsed_max = float(score_max)
    except (TypeError, ValueError):
        parsed_max = 5.0

    try:
        parsed_step = float(score_step)
    except (TypeError, ValueError):
        parsed_step = 0.5

    if parsed_max <= parsed_min:
        raise ValueError("La borne max doit etre strictement superieure a la borne min")

    if parsed_step <= 0:
        raise ValueError("Le pas de notation doit etre strictement positif")

    return {"scoreMin": parsed_min, "scoreMax": parsed_max, "scoreStep": parsed_step}


def normalize_criteria_labels(criteria: object) -> list[str]:
    labels = criteria if isinstance(criteria, list) else []
    normalized_labels = [str(label or "").strip() for label in labels]
    normalized_labels = [label for label in normalized_labels if label]

    if not normalized_labels:
        raise ValueError("Au moins un critere est requis")

    return normalized_labels


def list_scoring_grid_versions(db: Database, grid_id: str) -> list[dict]:
    rows = db.query_all(
        """
        SELECT id, grid_id AS gridId, version_number AS versionNumber, is_active AS isActive,
               score_min AS scoreMin, score_max AS scoreMax, score_step AS scoreStep,
               created_at AS createdAt, updated_at AS updatedAt
        FROM scoring_grid_versions
        WHERE grid_id = ?
        ORDER BY version_number DESC
        """,
        (grid_id,),
    )
    return [{**row, "isActive": bool(row["isActive"])} for row in rows]


def list_scoring_criteria_by_version(db: Database, version_id: str) -> list[dict]:
    rows = db.query_all(
        """
        SELECT id, grid_version_id AS gridVersionId, criterion_key AS criterionKey, label,
               sort_order AS sortOrder, is_enabled AS isEnabled, created_at AS createdAt, updated_at AS updatedAt
        FROM scoring_grid_criteria
        WHERE grid_version_id = ?
        ORDER BY sort_order ASC
        """,
        (version_id,),
    )
    return [{**row, "isEnabled": bool(row["isEnabled"])} for row in rows]


def list_scoring_grids(db: Database) -> list[dict]:
    grids = db.query_all(
        """
        SELECT id, grid_key AS gridKey, label, sector, division, created_at AS createdAt, updated_at AS updatedAt
        FROM scoring_grids
        ORDER BY sector ASC, division ASC
        """
    )

    result = []
    for grid in grids:
        versions = [
            {**version, "criteria": list_scoring_criteria_by_version(db, version["id"])}
            for version in list_scoring_grid_versions(db, grid["id"])
        ]
        active_version = next((version for version in versions if version["isActive"]), None)
        result.append({**grid, "versions": versions, "activeVersion": active_version})

    return result


def create_scoring_grid_version(
    db: Database,
    *,
    grid_key: str,
    criteria: object,
    score_min: object = 0,
    score_max: object = 5,
    score_step: object = 0.5,
    activate: bool = True,
) -> dict:
    normalized_grid_key = normalize_scoring_grid_key(grid_key)

    if not normalized_grid_key:
        raise ValueError("Type de grille invalide")

    grid = get_scoring_grid_by_key(db, normalized_grid_key)

    if grid is None:
        raise ValueError("Grille introuvable")

    normalized_criteria = normalize_criteria_labels(criteria)
    normalized_range = normalize_score_range(score_min, score_max, score_step)
    timestamp = now()

    with db.transaction():
        max_version = db.query_one(
            "SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM scoring_grid_versions WHERE grid_id = ?",
            (grid["id"],),
        )["maxVersion"]
        next_version_number = max_version + 1

        if activate:
            db.execute(
                "UPDATE scoring_grid_versions SET is_active = 0, updated_at = ? WHERE grid_id = ?",
                (timestamp, grid["id"]),
            )

        version_id = new_id()
        db.execute(
            """
            INSERT INTO scoring_grid_versions
                (id, grid_id, version_number, is_active, score_min, score_max, score_step, created_at, updated_at)
            VALUES (:id, :grid_id, :version_number, :is_active, :score_min, :score_max, :score_step, :created_at, :updated_at)
            """,
            {
                "id": version_id,
                "grid_id": grid["id"],
                "version_number": next_version_number,
                "is_active": 1 if activate else 0,
                "score_min": normalized_range["scoreMin"],
                "score_max": normalized_range["scoreMax"],
                "score_step": normalized_range["scoreStep"],
                "created_at": timestamp,
                "updated_at": timestamp,
            },
        )

        criterion_timestamp = timestamp
        for index, label in enumerate(normalized_criteria):
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
                    build_criterion_key(normalized_grid_key, index + 1, next_version_number),
                    label,
                    index + 1,
                    criterion_timestamp,
                    criterion_timestamp,
                ),
            )

    return {
        "grid": grid,
        "version": {
            "id": version_id,
            "versionNumber": next_version_number,
            "isActive": bool(activate),
            "scoreMin": normalized_range["scoreMin"],
            "scoreMax": normalized_range["scoreMax"],
            "scoreStep": normalized_range["scoreStep"],
            "criteria": list_scoring_criteria_by_version(db, version_id),
        },
    }


def set_active_scoring_grid_version(db: Database, *, grid_key: str, version_id: str) -> dict:
    normalized_grid_key = normalize_scoring_grid_key(grid_key)
    normalized_version_id = str(version_id or "").strip()

    if not normalized_grid_key:
        raise ValueError("Type de grille invalide")

    if not normalized_version_id:
        raise ValueError("Version de grille invalide")

    grid = get_scoring_grid_by_key(db, normalized_grid_key)

    if grid is None:
        raise ValueError("Grille introuvable")

    version = db.query_one(
        "SELECT id, grid_id AS gridId, version_number AS versionNumber FROM scoring_grid_versions WHERE id = ?",
        (normalized_version_id,),
    )

    if version is None or version["gridId"] != grid["id"]:
        raise ValueError("Version de grille introuvable pour ce type")

    timestamp = now()
    db.execute(
        """
        UPDATE scoring_grid_versions
        SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?
        WHERE grid_id = ?
        """,
        (version["id"], timestamp, grid["id"]),
    )

    return {
        "gridKey": normalized_grid_key,
        "activeVersionId": version["id"],
        "activeVersionNumber": version["versionNumber"],
    }


def list_scoring_criteria_catalog(db: Database) -> list[dict]:
    rows = db.query_all(
        """
        SELECT c.id, c.grid_version_id AS gridVersionId, c.criterion_key AS criterionKey, c.label,
               c.sort_order AS sortOrder, c.is_enabled AS isEnabled, g.grid_key AS gridKey, g.label AS gridLabel,
               g.sector, g.division, v.version_number AS versionNumber, v.score_min AS scoreMin,
               v.score_max AS scoreMax, v.score_step AS scoreStep
        FROM scoring_grid_criteria c
        INNER JOIN scoring_grid_versions v ON v.id = c.grid_version_id
        INNER JOIN scoring_grids g ON g.id = v.grid_id
        WHERE v.is_active = 1
        ORDER BY g.sector ASC, g.division ASC, c.sort_order ASC
        """
    )

    return [
        {
            **row,
            "criterionKey": build_criterion_key(row["gridKey"], row["sortOrder"], row["versionNumber"]),
            "isEnabled": bool(row["isEnabled"]),
        }
        for row in rows
    ]


def create_scoring_criterion(db: Database, *, grid_key: str, label: str, sort_order: object = None) -> dict:
    normalized_grid_key = normalize_scoring_grid_key(grid_key)
    normalized_label = str(label or "").strip()

    if not normalized_grid_key:
        raise ValueError("Type de grille invalide")

    if not normalized_label:
        raise ValueError("Le libellé du critère est obligatoire")

    active_version = get_active_scoring_grid_version(db, normalized_grid_key)

    if active_version is None:
        raise ValueError("Aucune version active pour cette grille")

    active_criteria = list_scoring_criteria_by_version(db, active_version["id"])

    try:
        insert_index = max(0, min(int(sort_order) - 1, len(active_criteria)))
    except (TypeError, ValueError):
        insert_index = len(active_criteria)

    next_labels = [criterion["label"] for criterion in active_criteria]
    next_labels.insert(insert_index, normalized_label)

    return create_scoring_grid_version(
        db,
        grid_key=normalized_grid_key,
        criteria=next_labels,
        score_min=active_version["scoreMin"],
        score_max=active_version["scoreMax"],
        score_step=active_version["scoreStep"],
        activate=True,
    )


def revise_scoring_criterion(db: Database, *, criterion_id: str, label: str) -> dict:
    normalized_criterion_id = str(criterion_id or "").strip()
    normalized_label = str(label or "").strip()

    if not normalized_criterion_id:
        raise ValueError("Le critère cible est obligatoire")

    if not normalized_label:
        raise ValueError("Le libellé du critère est obligatoire")

    criterion = db.query_one(
        """
        SELECT c.id, c.grid_version_id AS gridVersionId, c.sort_order AS sortOrder, g.grid_key AS gridKey,
               v.score_min AS scoreMin, v.score_max AS scoreMax, v.score_step AS scoreStep
        FROM scoring_grid_criteria c
        INNER JOIN scoring_grid_versions v ON v.id = c.grid_version_id
        INNER JOIN scoring_grids g ON g.id = v.grid_id
        WHERE c.id = ?
        """,
        (normalized_criterion_id,),
    )

    if criterion is None:
        raise ValueError("Critère introuvable")

    source_criteria = list_scoring_criteria_by_version(db, criterion["gridVersionId"])
    next_labels = [
        normalized_label if item["id"] == normalized_criterion_id else item["label"] for item in source_criteria
    ]

    return create_scoring_grid_version(
        db,
        grid_key=criterion["gridKey"],
        criteria=next_labels,
        score_min=criterion["scoreMin"],
        score_max=criterion["scoreMax"],
        score_step=criterion["scoreStep"],
        activate=True,
    )


def get_competition_scoring_profile(db: Database, competition_id: str) -> dict:
    competition = db.query_one(
        """
        SELECT id, artistic_solo_grid_version_id AS artisticSoloGridVersionId,
               artistic_duo_grid_version_id AS artisticDuoGridVersionId,
               technical_solo_grid_version_id AS technicalSoloGridVersionId,
               technical_duo_grid_version_id AS technicalDuoGridVersionId
        FROM competitions
        WHERE id = ?
        """,
        (competition_id,),
    )

    if competition is None:
        raise ValueError("Competition introuvable")

    versions_by_id = {
        row["id"]: row
        for row in db.query_all(
            """
            SELECT v.id, g.grid_key AS gridKey, g.label AS gridLabel, g.sector, g.division,
                   v.version_number AS versionNumber, v.score_min AS scoreMin, v.score_max AS scoreMax,
                   v.score_step AS scoreStep
            FROM scoring_grid_versions v
            INNER JOIN scoring_grids g ON g.id = v.grid_id
            """
        )
    }

    profile = {
        "artisticSolo": versions_by_id.get(competition["artisticSoloGridVersionId"]),
        "artisticDuo": versions_by_id.get(competition["artisticDuoGridVersionId"]),
        "technicalSolo": versions_by_id.get(competition["technicalSoloGridVersionId"]),
        "technicalDuo": versions_by_id.get(competition["technicalDuoGridVersionId"]),
    }

    for key, version in profile.items():
        if version:
            profile[key] = {**version, "criteria": list_scoring_criteria_by_version(db, version["id"])}

    return {"competitionId": competition["id"], "profile": profile}
