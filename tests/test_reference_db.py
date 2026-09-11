from __future__ import annotations

from pole_scoring.db.connection import Database


def test_python_schema_opens_real_app_pole_database(reference_db_copy) -> None:
    """Verifie que le portage Python peut ouvrir une copie de la vraie base
    app_pole (schema deja migre par la version Node) sans erreur, et que la
    lecture des donnees existantes fonctionne via notre propre wrapper."""
    db = Database(reference_db_copy)

    try:
        competitions = db.query_all("SELECT id, name, status FROM competitions")
        competitors = db.query_all("SELECT id, competition_id FROM competitors")
        judges = db.query_all("SELECT id, name FROM judges")

        assert len(competitions) > 0
        assert len(competitors) > 0
        assert len(judges) > 0

        # La vue de calcul des scores (portee telle quelle depuis db.js) doit
        # pouvoir etre interrogee sur les vraies donnees sans erreur SQL.
        metrics = db.query_all("SELECT * FROM competition_competitor_score_metrics LIMIT 5")
        assert isinstance(metrics, list)
    finally:
        db.close()
