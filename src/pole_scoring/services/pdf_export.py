"""Export PDF, porte depuis app_pole/src/server.js : genere un PDF en pilotant
Edge/Chrome installe sur le poste en mode headless (--print-to-pdf) contre une
page de l'appli elle-meme, pour un rendu identique a ce que produit la
version Node (meme moteur de rendu, meme CSS d'impression)."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from ..config import APP_PORT, DATA_DIR
from ..db.connection import Database
from ..utils.text import strip_accents
from ..utils.time import now
from ..utils.validation import require_string
from .competitions import list_competitions

PDF_EXPORT_CATEGORIES = {
    "scoring_sheets": {"folder": "scoring-sheets", "filePrefix": "scoring-sheets"},
    "individual_statistics": {"folder": "individual-statistics", "filePrefix": "individual-statistics"},
    "competition_results": {"folder": "competition-results", "filePrefix": "competition-results"},
}

PDF_EXPORT_ROOT = DATA_DIR / "exports"
PDF_EXPORT_INDEX_FILE = PDF_EXPORT_ROOT / "exports-index.json"


def sanitize_file_part(value: object) -> str:
    text = strip_accents(str(value or "")).strip()
    text = re.sub(r"['\u2019]", "-", text)
    text = re.sub(r"[^a-zA-Z0-9_-]+", "-", text)
    text = re.sub(r"-+", "-", text)
    text = text.strip("-")
    return text[:80].lower()


def format_date_for_file_name(value: object) -> str:
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(value or "").strip())
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else ""


def ensure_unique_pdf_file_path(directory: Path, file_name_base: str) -> dict:
    candidate_name = f"{file_name_base}.pdf"
    attempt = 1

    while (directory / candidate_name).exists():
        attempt += 1
        candidate_name = f"{file_name_base}-{attempt}.pdf"

    return {"fileName": candidate_name, "filePath": directory / candidate_name}


def get_competition_export_context(db: Database, competition_id: str) -> dict:
    normalized_id = str(competition_id or "").strip()
    competition = next(
        (item for item in list_competitions(db) if str(item.get("id") or "").strip() == normalized_id), None
    )

    if competition is None:
        return {
            "competitionNamePart": sanitize_file_part(normalized_id) or "competition",
            "competitionDatePart": "",
            "competitionId": normalized_id,
        }

    return {
        "competitionNamePart": sanitize_file_part(competition["name"]) or "competition",
        "competitionDatePart": format_date_for_file_name(competition["eventDate"]),
        "competitionId": competition["id"],
    }


def build_pdf_file_name_base(category: dict, payload: dict, competition_name_part: str, competition_date_part: str) -> str:
    parts = [part for part in (category["filePrefix"], competition_name_part) if part]

    if competition_date_part:
        parts.append(competition_date_part)

    if category["type"] == "competition_results":
        view = str(payload.get("view") or "").strip().lower()
        if view == "ranking":
            parts.append("classement-complet")
        elif view == "podium":
            parts.append("podium")
        else:
            parts.append("classement-plus-podium")

    if category["type"] == "individual_statistics":
        print_mode = str(payload.get("printMode") or payload.get("mode") or "").strip().lower()
        parts.append("candidat" if print_mode == "current" else "tous")

    if category["type"] == "scoring_sheets" and payload.get("onlyShadows") is True:
        parts.append("shadows")

    return "-".join(parts)


def read_pdf_export_index() -> list[dict]:
    PDF_EXPORT_ROOT.mkdir(parents=True, exist_ok=True)

    if not PDF_EXPORT_INDEX_FILE.exists():
        return []

    try:
        parsed = json.loads(PDF_EXPORT_INDEX_FILE.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, list) else []
    except (OSError, ValueError):
        return []


def write_pdf_export_index(entries: list[dict]) -> None:
    PDF_EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
    PDF_EXPORT_INDEX_FILE.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def register_pdf_export(*, type_: str, competition_id: str, file_name: str, folder_path: Path) -> None:
    index = read_pdf_export_index()
    file_path = str(folder_path / file_name)
    filtered = [entry for entry in index if entry.get("filePath") != file_path]

    filtered.append(
        {
            "type": type_,
            "competitionId": competition_id,
            "fileName": file_name,
            "folderPath": str(folder_path),
            "filePath": file_path,
            "createdAt": now(),
        }
    )

    write_pdf_export_index(filtered)


def cleanup_competition_pdf_exports(db: Database, competition_id: str) -> dict:
    normalized_competition_id = str(competition_id or "").strip()

    if not normalized_competition_id:
        return {"deletedCount": 0, "deletedFiles": []}

    index = read_pdf_export_index()
    to_delete = [
        entry for entry in index if str(entry.get("competitionId") or "").strip() == normalized_competition_id
    ]
    kept_entries = [
        entry for entry in index if str(entry.get("competitionId") or "").strip() != normalized_competition_id
    ]
    deleted_files: set[str] = set()

    for entry in to_delete:
        file_path = Path(str(entry.get("folderPath") or "").strip()) / str(entry.get("fileName") or "").strip()

        try:
            if file_path.exists():
                file_path.unlink()
                deleted_files.add(str(file_path))
        except OSError:
            pass

    context = get_competition_export_context(db, normalized_competition_id)

    for category in PDF_EXPORT_CATEGORIES.values():
        directory = PDF_EXPORT_ROOT / category["folder"]

        if not directory.exists():
            continue

        date_suffix = f"-{context['competitionDatePart']}" if context["competitionDatePart"] else ""
        new_prefix = f"{category['filePrefix']}-{context['competitionNamePart']}{date_suffix}"
        legacy_prefix = f"{category['filePrefix']}-{normalized_competition_id}-"

        for entry in directory.iterdir():
            if not entry.is_file() or entry.suffix.lower() != ".pdf":
                continue

            file_name = entry.name
            matches_new = bool(context["competitionNamePart"]) and file_name.startswith(new_prefix)
            matches_legacy = file_name.startswith(legacy_prefix)

            if not matches_new and not matches_legacy:
                continue

            try:
                entry.unlink()
                deleted_files.add(str(entry))
            except OSError:
                pass

    write_pdf_export_index(kept_entries)

    return {"deletedCount": len(deleted_files), "deletedFiles": sorted(deleted_files)}


def resolve_pdf_export_category(type_: str | None) -> dict:
    normalized_type = str(type_ or "").strip()
    category = PDF_EXPORT_CATEGORIES.get(normalized_type)

    if category is None:
        raise ValueError("Type d'export PDF non pris en charge")

    return {"type": normalized_type, **category}


def resolve_pdf_export_directory(type_: str | None) -> dict:
    category = resolve_pdf_export_category(type_)
    directory = PDF_EXPORT_ROOT / category["folder"]
    directory.mkdir(parents=True, exist_ok=True)
    return {"category": category, "directory": directory}


def sanitize_export_file_name(value: object) -> str:
    file_name = str(value or "").strip()

    if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
        raise ValueError("Nom de fichier export invalide")

    if not file_name.lower().endswith(".pdf"):
        raise ValueError("Seuls les fichiers PDF sont autorisés")

    return file_name


def list_exported_pdf_files(type_: str | None) -> dict:
    resolved = resolve_pdf_export_directory(type_)
    category, directory = resolved["category"], resolved["directory"]

    entries = []
    for entry in directory.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".pdf":
            continue

        stats = entry.stat()
        entries.append({"name": entry.name, "bytes": stats.st_size, "updatedAt": _iso_from_timestamp(stats.st_mtime)})

    entries.sort(key=lambda item: item["updatedAt"], reverse=True)

    return {"type": category["type"], "folderPath": str(directory), "files": entries}


def _iso_from_timestamp(timestamp: float) -> str:
    moment = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def read_exported_pdf_file(type_: str | None, file_name_input: object) -> dict:
    resolved = resolve_pdf_export_directory(type_)
    category, directory = resolved["category"], resolved["directory"]
    file_name = sanitize_export_file_name(file_name_input)
    file_path = directory / file_name

    if not str(file_path.resolve()).startswith(str(directory.resolve())) or not file_path.exists():
        raise ValueError("Fichier export introuvable")

    return {"type": category["type"], "fileName": file_name, "filePath": str(file_path), "content": file_path.read_bytes()}


def _escape_html(value: object) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def build_pdf_browse_html(type_: str | None) -> str:
    listing = list_exported_pdf_files(type_)
    rows = "".join(
        f'<li><a href="/api/pdf/download?type={listing["type"]}&name={file["name"]}" '
        f'target="_blank" rel="noopener">{_escape_html(file["name"])}</a> '
        f'<small>({file["bytes"]} octets)</small></li>'
        for file in listing["files"]
    )
    body = f"<ul>{rows}</ul>" if rows else "<p>Aucun PDF exporté pour le moment.</p>"

    return f"""<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Exports PDF - {_escape_html(listing["type"])}</title>
    <style>
      body {{ font-family: Segoe UI, sans-serif; margin: 24px; }}
      h1 {{ margin-bottom: 8px; }}
      p {{ color: #333; }}
      ul {{ line-height: 1.8; padding-left: 20px; }}
      small {{ color: #666; }}
    </style>
  </head>
  <body>
    <h1>Exports PDF - {_escape_html(listing["type"])}</h1>
    <p>{_escape_html(listing["folderPath"])}</p>
    {body}
  </body>
</html>"""


def build_pdf_target_url(db: Database, payload: dict) -> dict:
    category = resolve_pdf_export_category(payload.get("type"))
    competition_id = require_string(payload.get("competitionId"), "competitionId")
    params = {"competitionId": competition_id, "exportPdf": "1"}

    if category["type"] == "scoring_sheets":
        if payload.get("onlyShadows") is True:
            params["onlyShadows"] = "1"
        return {"relativeUrl": f"/scoring-sheets.html?{urlencode(params)}", "competitionId": competition_id, "category": category}

    if category["type"] == "competition_results":
        view = str(payload.get("view") or "").strip()
        if view in ("ranking", "podium", "all"):
            params["view"] = view
        return {"relativeUrl": f"/competition-results.html?{urlencode(params)}", "competitionId": competition_id, "category": category}

    print_mode = "current" if str(payload.get("printMode") or payload.get("mode") or "").strip().lower() == "current" else "all"
    params["printMode"] = print_mode

    if print_mode == "current":
        params["competitorId"] = require_string(payload.get("competitorId"), "competitorId")

    hide_shadow_comments = payload.get("hideShadowComments")
    if hide_shadow_comments is True or hide_shadow_comments is False:
        params["hideShadowComments"] = "true" if hide_shadow_comments else "false"

    return {"relativeUrl": f"/individual-statistics.html?{urlencode(params)}", "competitionId": competition_id, "category": category}


def resolve_browser_executable() -> str:
    program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    program_files = os.environ.get("ProgramFiles", r"C:\Program Files")

    candidates = [
        os.environ.get("POLE_SCORING_BROWSER_PATH"),
        os.environ.get("POLE_SCORING_PDF_BROWSER"),
        str(Path(program_files_x86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
        str(Path(program_files) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
        str(Path(program_files_x86) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        str(Path(program_files) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]

    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate

    return ""


def open_path_in_explorer(target_path: str) -> bool:
    resolved_path = str(Path(str(target_path or "").strip()).resolve())

    if not resolved_path:
        return False

    try:
        if sys.platform == "win32":
            os.startfile(resolved_path)  # type: ignore[attr-defined]
            return True

        opener = "open" if sys.platform == "darwin" else "xdg-open"
        result = subprocess.run(
            [opener, resolved_path], timeout=7, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def run_pdf_engine(executable: str, args: list[str]) -> None:
    result = subprocess.run([executable, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(stderr or f"Le moteur PDF a échoué (code {result.returncode})")


def export_pdf(db: Database, payload: dict) -> dict:
    browser_executable = resolve_browser_executable()

    if not browser_executable:
        raise ValueError("Navigateur Edge/Chrome introuvable pour la génération PDF")

    target = build_pdf_target_url(db, payload)
    export_directory = PDF_EXPORT_ROOT / target["category"]["folder"]
    export_directory.mkdir(parents=True, exist_ok=True)

    competition_context = get_competition_export_context(db, target["competitionId"])
    file_name_base = build_pdf_file_name_base(
        target["category"], payload, competition_context["competitionNamePart"], competition_context["competitionDatePart"]
    )
    output = ensure_unique_pdf_file_path(export_directory, file_name_base)
    file_name = output["fileName"]
    output_path: Path = output["filePath"]
    export_url = f"http://127.0.0.1:{APP_PORT}{target['relativeUrl']}"

    run_pdf_engine(
        browser_executable,
        [
            "--headless=new",
            "--disable-gpu",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=16000",
            "--no-pdf-header-footer",
            "--window-size=1600,1000",
            f"--print-to-pdf={output_path}",
            export_url,
        ],
    )

    if not output_path.exists():
        raise ValueError("Le fichier PDF n'a pas été généré")

    stats = output_path.stat()
    if stats.st_size <= 0:
        raise ValueError("Le fichier PDF généré est vide")

    # On n'ouvre plus le fichier PDF lui-meme ici (Start-Process sur un .pdf
    # lance le lecteur PDF par defaut, qui vole le focus a la fenetre
    # Explorer ouverte juste apres par le client via /api/pdf/open-folder).
    # L'ouverture du dossier d'export reste la seule action declenchee,
    # demandee explicitement par le client apres un export reussi.
    register_pdf_export(
        type_=target["category"]["type"],
        competition_id=competition_context["competitionId"],
        file_name=file_name,
        folder_path=export_directory,
    )

    return {
        "ok": True,
        "opened": False,
        "type": target["category"]["type"],
        "fileName": file_name,
        "filePath": str(output_path),
        "folderPath": str(export_directory),
        "bytes": stats.st_size,
    }
