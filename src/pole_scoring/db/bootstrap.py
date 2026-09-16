"""Taches executees une fois au demarrage, a l'identique des boucles/appels
places en bas de module dans app_pole/src/db.js : retro-remplissage des
donnees anciennes (membres de competiteurs, saison/niveau/nombre de juges
des competitions) puis creation des grilles de notation par defaut."""

from __future__ import annotations

from ..services.competitions import (
    normalize_competition_level,
    normalize_competition_territory,
    normalize_judge_count,
    normalize_season,
)
from ..services.competitors import normalize_competitor_members, sync_competitor_members
from ..services.presenter import clear_presenter_active_passage
from ..services.scores import refresh_all_competitor_score_summaries
from ..services.scoring_grids import ensure_default_scoring_grids
from ..utils.time import now
from .connection import Database


def _backfill_competitor_members(db: Database) -> None:
    competitors = db.query_all(
        """
        SELECT id, stage_name AS stageName, COALESCE(first_name, '') AS firstName,
               COALESCE(last_name, '') AS lastName, created_at AS createdAt, updated_at AS updatedAt
        FROM competitors
        """
    )

    for competitor in competitors:
        existing_member_count = db.query_one(
            "SELECT COUNT(*) AS count FROM competitor_members WHERE competitor_id = ?", (competitor["id"],)
        )["count"]

        if existing_member_count > 0:
            continue

        sync_competitor_members(
            db,
            {
                "id": competitor["id"],
                "stage_name": competitor["stageName"],
                "first_name": competitor["firstName"],
                "last_name": competitor["lastName"],
                "updated_at": competitor["updatedAt"] or competitor["createdAt"] or now(),
                "members": normalize_competitor_members(
                    {"first_name": competitor["firstName"], "last_name": competitor["lastName"]}
                ),
            },
        )


def _backfill_competition_defaults(db: Database) -> None:
    competitions = db.query_all(
        """
        SELECT id, event_date AS eventDate, COALESCE(competition_level, '') AS competitionLevel,
               COALESCE(region, '') AS region, COALESCE(zone, '') AS zone, judge_count AS judgeCount,
               (
                 SELECT COUNT(*)
                 FROM judge_competition_authorizations a
                 WHERE a.competition_id = competitions.id AND a.is_authorized = 1
               ) AS authorizedJudgeCount
        FROM competitions
        WHERE COALESCE(season, '') = ''
           OR COALESCE(competition_level, '') = ''
           OR judge_count IS NULL
           OR judge_count < 1
        """
    )

    for competition in competitions:
        competition_level = normalize_competition_level(competition["competitionLevel"])
        territory = normalize_competition_territory(competition_level, competition["region"], competition["zone"])
        judge_count = normalize_judge_count(competition["judgeCount"], competition["authorizedJudgeCount"] or 3)

        db.execute(
            """
            UPDATE competitions
            SET season = ?, competition_level = ?, region = ?, zone = ?, judge_count = ?
            WHERE id = ?
            """,
            (
                normalize_season("", competition["eventDate"]),
                competition_level,
                territory["region"],
                territory["zone"],
                judge_count,
                competition["id"],
            ),
        )


def run_startup_tasks(db: Database) -> None:
    _backfill_competitor_members(db)
    _backfill_competition_defaults(db)
    ensure_default_scoring_grids(db)
    refresh_all_competitor_score_summaries(db)
    clear_presenter_active_passage(db)
