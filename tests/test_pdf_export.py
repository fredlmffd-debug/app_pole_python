from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import competitions as competitions_service
from pole_scoring.services import pdf_export


def test_sanitize_file_part_strips_accents_and_specials() -> None:
    assert pdf_export.sanitize_file_part("Championnat d'Été 2026 !") == "championnat-d-ete-2026"
    assert pdf_export.sanitize_file_part("") == ""


def test_format_date_for_file_name() -> None:
    assert pdf_export.format_date_for_file_name("2026-09-16") == "16-09-2026"
    assert pdf_export.format_date_for_file_name("not-a-date") == ""


def test_ensure_unique_pdf_file_path(tmp_path) -> None:
    first = pdf_export.ensure_unique_pdf_file_path(tmp_path, "rapport")
    assert first["fileName"] == "rapport.pdf"

    first["filePath"].write_bytes(b"%PDF-1.4")
    second = pdf_export.ensure_unique_pdf_file_path(tmp_path, "rapport")
    assert second["fileName"] == "rapport-2.pdf"


def test_build_pdf_file_name_base_variants() -> None:
    scoring_category = {"filePrefix": "scoring-sheets", "type": "scoring_sheets"}
    assert (
        pdf_export.build_pdf_file_name_base(scoring_category, {}, "comp", "16-09-2026")
        == "scoring-sheets-comp-16-09-2026"
    )

    results_category = {"filePrefix": "competition-results", "type": "competition_results"}
    assert (
        pdf_export.build_pdf_file_name_base(results_category, {"view": "podium"}, "comp", "")
        == "competition-results-comp-podium"
    )

    stats_category = {"filePrefix": "individual-statistics", "type": "individual_statistics"}
    assert (
        pdf_export.build_pdf_file_name_base(stats_category, {"printMode": "current"}, "comp", "")
        == "individual-statistics-comp-candidat"
    )


def test_get_competition_export_context_falls_back_when_missing(bootstrapped_db: Database) -> None:
    context = pdf_export.get_competition_export_context(bootstrapped_db, "missing-id")
    assert context["competitionNamePart"] == "missing-id"
    assert context["competitionDatePart"] == ""

    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp Export", event_date="2026-09-16"
    )
    context = pdf_export.get_competition_export_context(bootstrapped_db, competition["id"])
    assert context["competitionNamePart"] == "comp-export"
    assert context["competitionDatePart"] == "16-09-2026"


def test_resolve_pdf_export_category_rejects_unknown_type() -> None:
    with pytest.raises(ValueError):
        pdf_export.resolve_pdf_export_category("unknown")


def test_build_pdf_target_url_variants(bootstrapped_db: Database) -> None:
    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp URL", event_date="2026-09-16"
    )

    scoring_target = pdf_export.build_pdf_target_url(
        bootstrapped_db, {"type": "scoring_sheets", "competitionId": competition["id"]}
    )
    assert scoring_target["relativeUrl"].startswith("/scoring-sheets.html?")

    results_target = pdf_export.build_pdf_target_url(
        bootstrapped_db, {"type": "competition_results", "competitionId": competition["id"], "view": "podium"}
    )
    assert "view=podium" in results_target["relativeUrl"]

    with pytest.raises(ValueError):
        pdf_export.build_pdf_target_url(
            bootstrapped_db, {"type": "individual_statistics", "printMode": "current"}
        )  # competitorId manquant

    stats_target = pdf_export.build_pdf_target_url(
        bootstrapped_db,
        {
            "type": "individual_statistics",
            "competitionId": competition["id"],
            "printMode": "current",
            "competitorId": "abc",
            "hideShadowComments": True,
        },
    )
    assert "printMode=current" in stats_target["relativeUrl"]
    assert "competitorId=abc" in stats_target["relativeUrl"]
    assert "hideShadowComments=true" in stats_target["relativeUrl"]


def test_pdf_export_index_register_list_and_cleanup(bootstrapped_db: Database, monkeypatch, tmp_path) -> None:
    export_root = tmp_path / "exports"
    monkeypatch.setattr(pdf_export, "PDF_EXPORT_ROOT", export_root)
    monkeypatch.setattr(pdf_export, "PDF_EXPORT_INDEX_FILE", export_root / "exports-index.json")

    competition = competitions_service.create_competition(
        bootstrapped_db, name="Comp Cleanup", event_date="2026-09-16"
    )

    directory = export_root / "scoring-sheets"
    directory.mkdir(parents=True)
    file_path = directory / "scoring-sheets-comp-cleanup-16-09-2026.pdf"
    file_path.write_bytes(b"%PDF-1.4")

    pdf_export.register_pdf_export(
        type_="scoring_sheets", competition_id=competition["id"], file_name=file_path.name, folder_path=directory
    )

    listing = pdf_export.list_exported_pdf_files("scoring_sheets")
    assert len(listing["files"]) == 1
    assert listing["files"][0]["name"] == file_path.name

    read_back = pdf_export.read_exported_pdf_file("scoring_sheets", file_path.name)
    assert read_back["content"] == b"%PDF-1.4"

    cleanup_result = pdf_export.cleanup_competition_pdf_exports(bootstrapped_db, competition["id"])
    assert cleanup_result["deletedCount"] == 1
    assert not file_path.exists()
    assert pdf_export.read_pdf_export_index() == []


def test_sanitize_export_file_name_rejects_path_traversal() -> None:
    with pytest.raises(ValueError):
        pdf_export.sanitize_export_file_name("../secret.pdf")

    with pytest.raises(ValueError):
        pdf_export.sanitize_export_file_name("report.txt")

    assert pdf_export.sanitize_export_file_name("report.pdf") == "report.pdf"
