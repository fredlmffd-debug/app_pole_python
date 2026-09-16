from __future__ import annotations

import math

from ..db.connection import Database
from ..db.events import record_event, delete_entity
from ..db.settings import get_node_id
from ..utils.ids import new_id
from ..utils.time import now
from .judges import is_judge_authorized_for_competition
from .presenter import assert_presenter_passage_active, clear_presenter_active_passage, get_presenter_active_passage

SCORE_UPSERT_SQL = """
INSERT INTO scores (
  id, competition_id, competitor_id, judge_id, criterion, score, comment, source_node_id, created_at, updated_at
)
VALUES (
  :id, :competition_id, :competitor_id, :judge_id, :criterion, :score, :comment, :source_node_id, :created_at, :updated_at
)
ON CONFLICT(id) DO UPDATE SET
  competition_id = excluded.competition_id,
  competitor_id = excluded.competitor_id,
  judge_id = excluded.judge_id,
  criterion = excluded.criterion,
  score = excluded.score,
  comment = excluded.comment,
  source_node_id = excluded.source_node_id,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > scores.updated_at
"""


def _coerce_score_like_js(score: object) -> float:
    """Reproduit `typeof score === 'number' ? score : Number(String(score ?? '').trim().replace(',', '.'))`
    cote JS, y compris la particularite `Number('') === 0` (score absent -> 0)."""
    if isinstance(score, (int, float)) and not isinstance(score, bool):
        return float(score)

    text = str(score if score is not None else "").strip().replace(",", ".")

    if text == "":
        return 0.0

    try:
        return float(text)
    except ValueError:
        return float("nan")


def add_score(
    db: Database, *, competition_id: str, competitor_id: str, judge_id: str, criterion: str, score: object, comment: str = ""
) -> dict:
    if not is_judge_authorized_for_competition(db, competition_id, judge_id):
        raise ValueError("Ce juge n'est pas autorisé pour la compétition sélectionnée")

    normalized_criterion = str(criterion or "").strip()
    normalized_score = _coerce_score_like_js(score)

    is_penalty_score = normalized_criterion == "penalty:total" or normalized_criterion.startswith("penalty:")

    if not math.isfinite(normalized_score) or normalized_score < 0 or (not is_penalty_score and normalized_score > 5):
        raise ValueError(
            "La pénalité doit être supérieure ou égale à 0" if is_penalty_score else "La note doit etre comprise entre 0 et 5"
        )

    if abs((normalized_score * 2) - round(normalized_score * 2)) > 1e-9:
        raise ValueError("La note doit respecter un pas de 0,5")

    timestamp = now()
    entry = {
        "id": new_id(),
        "competition_id": competition_id,
        "competitor_id": competitor_id,
        "judge_id": judge_id,
        "criterion": normalized_criterion,
        "score": normalized_score,
        "comment": comment,
        "source_node_id": get_node_id(db),
        "created_at": timestamp,
        "updated_at": timestamp,
    }

    db.execute(SCORE_UPSERT_SQL, entry)
    record_event(db, "score", entry["id"], "upsert", entry, entry["source_node_id"])
    return entry


SCORE_ROW_SELECT_COLUMNS = """
    SELECT id,
           competition_id AS competitionId,
           competitor_id AS competitorId,
           judge_id AS judgeId,
           criterion,
           score,
           comment,
           source_node_id AS sourceNodeId,
           created_at AS createdAt,
           updated_at AS updatedAt
    FROM scores
"""


def list_competitor_scores(db: Database, competition_id: str, competitor_id: str) -> list[dict]:
    return db.query_all(
        SCORE_ROW_SELECT_COLUMNS
        + """
        WHERE competition_id = ?
          AND competitor_id = ?
          AND (
            criterion LIKE 'artistic:%'
            OR criterion LIKE 'technical:%'
            OR criterion LIKE 'penalty:%'
            OR criterion LIKE 'judge:%'
          )
        ORDER BY updated_at DESC
        """,
        (competition_id, competitor_id),
    )


def list_scores(db: Database, competition_id: str) -> list[dict]:
    return db.query_all(
        SCORE_ROW_SELECT_COLUMNS + " WHERE competition_id = ? ORDER BY updated_at DESC",
        (competition_id,),
    )


def list_judge_category_history(
    db: Database,
    *,
    competition_id: str,
    judge_id: str,
    category: str,
    before_running_order: object,
    limit: object = 8,
) -> list[dict]:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_judge_id = str(judge_id or "").strip()
    normalized_category = str(category or "").strip()

    try:
        normalized_before_running_order = int(before_running_order)
    except (TypeError, ValueError):
        normalized_before_running_order = None

    try:
        normalized_limit = max(1, min(30, int(limit)))
    except (TypeError, ValueError):
        normalized_limit = 8

    if (
        not normalized_competition_id
        or not normalized_judge_id
        or not normalized_category
        or normalized_before_running_order is None
    ):
        return []

    previous_competitors = db.query_all(
        """
        SELECT c.id AS competitorId,
               c.stage_name AS stageName,
               COALESCE(c.first_name, '') AS firstName,
               COALESCE(c.last_name, '') AS lastName,
               c.running_order AS runningOrder,
               (
                 SELECT MAX(sf.updated_at)
                 FROM scores sf
                 WHERE sf.competition_id = c.competition_id
                   AND sf.competitor_id = c.id
                   AND sf.judge_id = ?
                   AND sf.criterion = 'judge:finalized'
               ) AS finalizedAt
        FROM competitors c
        WHERE c.competition_id = ?
          AND LOWER(TRIM(COALESCE(c.category, ''))) = LOWER(TRIM(?))
          AND c.running_order < ?
          AND EXISTS (
            SELECT 1
            FROM scores sf
            WHERE sf.competition_id = c.competition_id
              AND sf.competitor_id = c.id
              AND sf.judge_id = ?
              AND (
                sf.criterion = 'judge:finalized'
                OR sf.criterion LIKE 'artistic:%'
                OR sf.criterion LIKE 'technical:%'
              )
          )
        ORDER BY c.running_order ASC
        LIMIT ?
        """,
        (
            normalized_judge_id,
            normalized_competition_id,
            normalized_category,
            normalized_before_running_order,
            normalized_judge_id,
            normalized_limit,
        ),
    )

    details_sql = """
        SELECT criterion, score, comment, updated_at AS updatedAt
        FROM scores
        WHERE competition_id = ?
          AND competitor_id = ?
          AND judge_id = ?
          AND (
            criterion LIKE 'artistic:%'
            OR criterion LIKE 'technical:%'
            OR criterion = 'penalty:total'
            OR criterion = 'judge:comment'
          )
        ORDER BY
          CASE
            WHEN criterion LIKE 'artistic:%' THEN 1
            WHEN criterion LIKE 'technical:%' THEN 2
            WHEN criterion = 'penalty:total' THEN 3
            WHEN criterion = 'judge:comment' THEN 4
            ELSE 9
          END,
          updated_at ASC
    """

    history = []
    for competitor in previous_competitors:
        details = db.query_all(
            details_sql, (normalized_competition_id, competitor["competitorId"], normalized_judge_id)
        )
        total_score = sum(
            detail["score"]
            for detail in details
            if str(detail["criterion"] or "").startswith(("artistic:", "technical:"))
            and isinstance(detail["score"], (int, float))
        )
        penalty_entry = next((d for d in details if str(d["criterion"] or "").strip() == "penalty:total"), None)
        comment_entry = next((d for d in details if str(d["criterion"] or "").strip() == "judge:comment"), None)

        history.append(
            {
                **competitor,
                "totalScore": total_score,
                "penaltyScore": penalty_entry["score"] if penalty_entry and isinstance(penalty_entry["score"], (int, float)) else 0,
                "judgeComment": str(comment_entry["comment"] if comment_entry else "" or "").strip(),
                "details": [
                    {
                        "criterion": str(detail["criterion"] or "").strip(),
                        "score": detail["score"],
                        "comment": str(detail["comment"] or "").strip(),
                    }
                    for detail in details
                ],
            }
        )

    return history


def save_judge_draft_score(
    db: Database, *, competition_id: str, competitor_id: str, judge_id: str, criterion: str, score: object, comment: str = ""
) -> dict:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_competitor_id = str(competitor_id or "").strip()
    normalized_judge_id = str(judge_id or "").strip()
    normalized_criterion = str(criterion or "").strip()

    if not normalized_competition_id or not normalized_competitor_id or not normalized_judge_id or not normalized_criterion:
        raise ValueError("Compétition, compétiteur, juge ou critère invalide")

    is_valid_criterion = (
        normalized_criterion.startswith("artistic:")
        or normalized_criterion.startswith("technical:")
        or normalized_criterion == "penalty:total"
        or normalized_criterion == "judge:comment"
    )

    if not is_valid_criterion:
        raise ValueError("Critère de brouillon invalide")

    assert_presenter_passage_active(db, normalized_competition_id, normalized_competitor_id)

    existing_scores = db.query_all(
        "SELECT id FROM scores WHERE competition_id = ? AND competitor_id = ? AND judge_id = ? AND criterion = ?",
        (normalized_competition_id, normalized_competitor_id, normalized_judge_id, normalized_criterion),
    )
    deletion_timestamp = now()

    with db.transaction():
        node_id = get_node_id(db)
        for existing_score in existing_scores:
            delete_entity(db, "score", existing_score["id"])
            record_event(db, "score", existing_score["id"], "delete", {"id": existing_score["id"], "updated_at": deletion_timestamp}, node_id)

        saved_score = add_score(
            db,
            competition_id=normalized_competition_id,
            competitor_id=normalized_competitor_id,
            judge_id=normalized_judge_id,
            criterion=normalized_criterion,
            score=score,
            comment=comment,
        )

    return {
        "competitionId": normalized_competition_id,
        "competitorId": normalized_competitor_id,
        "judgeId": normalized_judge_id,
        "criterion": normalized_criterion,
        "score": saved_score["score"],
        "deletedCount": len(existing_scores),
        "savedScoreId": saved_score["id"],
    }


def _validate_scorecard_entries(entries: list[dict]) -> list[dict]:
    normalized_entries = [
        {
            "criterion": str(entry.get("criterion") or "").strip(),
            "score": entry.get("score"),
            "comment": str(entry.get("comment") or "").strip(),
        }
        for entry in entries
    ]

    if any(not entry["criterion"] for entry in normalized_entries):
        raise ValueError("Chaque note doit contenir un critère")

    if any(
        not entry["criterion"].startswith("artistic:")
        and not entry["criterion"].startswith("technical:")
        and entry["criterion"] != "penalty:total"
        and entry["criterion"] != "judge:comment"
        for entry in normalized_entries
    ):
        raise ValueError("Les critères transmis sont invalides")

    seen_criteria = set()
    for entry in normalized_entries:
        if entry["criterion"] in seen_criteria:
            raise ValueError("Un critère est envoyé plusieurs fois")
        seen_criteria.add(entry["criterion"])

    return normalized_entries


def save_judge_scorecard(db: Database, *, competition_id: str, competitor_id: str, judge_id: str, entries: list[dict]) -> dict:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_competitor_id = str(competitor_id or "").strip()
    normalized_judge_id = str(judge_id or "").strip()

    if not normalized_competition_id or not normalized_competitor_id or not normalized_judge_id:
        raise ValueError("Compétition, compétiteur ou juge invalide")

    if not is_judge_authorized_for_competition(db, normalized_competition_id, normalized_judge_id):
        raise ValueError("Ce juge n'est pas autorisé pour la compétition sélectionnée")

    assert_presenter_passage_active(db, normalized_competition_id, normalized_competitor_id)

    if db.query_one(
        "SELECT id FROM competitors WHERE id = ? AND competition_id = ?",
        (normalized_competitor_id, normalized_competition_id),
    ) is None:
        raise ValueError("Compétiteur introuvable pour cette compétition")

    if not isinstance(entries, list):
        raise ValueError("Le format des notes est invalide")

    normalized_entries = _validate_scorecard_entries(entries)
    primary_entries = [e for e in normalized_entries if e["criterion"].startswith(("artistic:", "technical:"))]

    if not primary_entries:
        raise ValueError("Aucune note artistique ou technique à enregistrer")

    existing_judge_scores = db.query_all(
        """
        SELECT id FROM scores
        WHERE competition_id = ? AND competitor_id = ? AND judge_id = ?
          AND (criterion LIKE 'artistic:%' OR criterion LIKE 'technical:%' OR criterion = 'penalty:total' OR criterion = 'judge:comment')
        """,
        (normalized_competition_id, normalized_competitor_id, normalized_judge_id),
    )
    existing_validation_scores = db.query_all(
        "SELECT id FROM scores WHERE competition_id = ? AND competitor_id = ? AND judge_id = ? AND criterion = 'judge:finalized'",
        (normalized_competition_id, normalized_competitor_id, normalized_judge_id),
    )
    deletion_timestamp = now()

    with db.transaction():
        node_id = get_node_id(db)
        for score in existing_judge_scores + existing_validation_scores:
            delete_entity(db, "score", score["id"])
            record_event(db, "score", score["id"], "delete", {"id": score["id"], "updated_at": deletion_timestamp}, node_id)

        saved_scores = [
            add_score(
                db,
                competition_id=normalized_competition_id,
                competitor_id=normalized_competitor_id,
                judge_id=normalized_judge_id,
                criterion=entry["criterion"],
                score=entry["score"],
                comment=entry["comment"],
            )
            for entry in normalized_entries
        ]

        add_score(
            db,
            competition_id=normalized_competition_id,
            competitor_id=normalized_competitor_id,
            judge_id=normalized_judge_id,
            criterion="judge:finalized",
            score=1,
            comment="finalized",
        )

    return {
        "competitionId": normalized_competition_id,
        "competitorId": normalized_competitor_id,
        "judgeId": normalized_judge_id,
        "deletedCount": len(existing_judge_scores),
        "savedCount": len(saved_scores),
        "finalized": True,
    }


def save_manual_scores(db: Database, *, competition_id: str, competitor_id: str, entries: list[dict]) -> dict:
    normalized_competition_id = str(competition_id or "").strip()
    normalized_competitor_id = str(competitor_id or "").strip()

    if not normalized_competition_id or not normalized_competitor_id:
        raise ValueError("Compétition ou compétiteur invalide")

    if db.query_one(
        "SELECT id FROM competitors WHERE id = ? AND competition_id = ?",
        (normalized_competitor_id, normalized_competition_id),
    ) is None:
        raise ValueError("Compétiteur introuvable pour cette compétition")

    if not isinstance(entries, list):
        raise ValueError("Le format des notes est invalide")

    normalized_entries = [
        {
            "judgeId": str(entry.get("judgeId") or "").strip(),
            "criterion": str(entry.get("criterion") or "").strip(),
            "score": entry.get("score"),
            "comment": str(entry.get("comment") or "").strip(),
        }
        for entry in entries
    ]

    if any(not entry["judgeId"] or not entry["criterion"] for entry in normalized_entries):
        raise ValueError("Chaque note doit contenir un juge et un critère")

    if any(
        not entry["criterion"].startswith("artistic:")
        and not entry["criterion"].startswith("technical:")
        and entry["criterion"] != "penalty:total"
        and entry["criterion"] != "judge:comment"
        for entry in normalized_entries
    ):
        raise ValueError("Les critères transmis sont invalides")

    judge_ids_to_finalize = {
        entry["judgeId"] for entry in normalized_entries if entry["criterion"].startswith(("artistic:", "technical:"))
    }

    existing_manual_scores = list_competitor_scores(db, normalized_competition_id, normalized_competitor_id)
    timestamp = now()

    with db.transaction():
        node_id = get_node_id(db)
        for score in existing_manual_scores:
            delete_entity(db, "score", score["id"])
            record_event(db, "score", score["id"], "delete", {"id": score["id"], "updated_at": timestamp}, node_id)

        saved_scores = [
            add_score(
                db,
                competition_id=normalized_competition_id,
                competitor_id=normalized_competitor_id,
                judge_id=entry["judgeId"],
                criterion=entry["criterion"],
                score=entry["score"],
                comment=entry["comment"],
            )
            for entry in normalized_entries
        ]

        for judge_id in judge_ids_to_finalize:
            add_score(
                db,
                competition_id=normalized_competition_id,
                competitor_id=normalized_competitor_id,
                judge_id=judge_id,
                criterion="judge:finalized",
                score=1,
                comment="finalized",
            )

        if not normalized_entries:
            current_active_passage = get_presenter_active_passage(db)
            active_competition_id = str((current_active_passage or {}).get("competitionId") or "").strip()
            active_competitor_id = str((current_active_passage or {}).get("competitorId") or "").strip()

            if active_competition_id == normalized_competition_id and active_competitor_id == normalized_competitor_id:
                clear_presenter_active_passage(db)

    return {
        "competitionId": normalized_competition_id,
        "competitorId": normalized_competitor_id,
        "deletedCount": len(existing_manual_scores),
        "savedCount": len(saved_scores),
        "finalizedJudgeCount": len(judge_ids_to_finalize),
    }


def refresh_all_competitor_score_summaries(db: Database) -> None:
    with db.transaction():
        db.execute("DELETE FROM competitor_score_summaries")
        db.execute(
            """
            INSERT INTO competitor_score_summaries (
              competition_id, competitor_id, artistic_score, technical_score, penalty_total,
              final_score, score_count, required_count, updated_at
            )
            SELECT competitionId, competitorId, artisticScore, technicalScore, penaltyTotal,
                   finalScore, scoreCount, requiredCount, ?
            FROM competition_competitor_score_metrics
            """,
            (now(),),
        )


def get_results(db: Database, competition_id: str, category: str = "") -> list[dict]:
    normalized_category = str(category or "").strip()

    return db.query_all(
        """
        SELECT c.id,
               c.stage_name AS stageName,
               COALESCE(c.first_name, '') AS firstName,
               COALESCE(c.last_name, '') AS lastName,
               c.category,
               c.running_order AS runningOrder,
               COALESCE(c.is_resident, 0) AS isResident,
               COALESCE(c.status, 'registered') AS status,
               ROUND(ss.artistic_score, 2) AS artisticScore,
               ROUND(ss.technical_score, 2) AS technicalScore,
               ROUND(ss.penalty_total, 2) AS penaltyTotal,
               ROUND(ss.final_score, 2) AS averageScore,
               ROUND(ss.final_score, 2) AS finalScore,
               COALESCE(ss.score_count, 0) AS scoreCount,
               COALESCE(ss.required_count, 0) AS requiredCount
        FROM competitors c
        LEFT JOIN competitor_score_summaries ss
          ON ss.competition_id = c.competition_id AND ss.competitor_id = c.id
        WHERE c.competition_id = ?
          AND (? = '' OR c.category = ?)
        ORDER BY CASE WHEN ss.final_score IS NULL THEN 1 ELSE 0 END,
                 ss.final_score DESC,
                 ss.technical_score DESC,
                 runningOrder ASC
        """,
        (competition_id, normalized_category, normalized_category),
    )
