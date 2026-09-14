from __future__ import annotations

import re
import unicodedata


def strip_accents(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_identity_name(value: str | None) -> str:
    """Nom normalise pour comparaison (trim, espaces internes reduits,
    minuscules) : utilise pour detecter les doublons de competition/competiteur."""
    return collapse_whitespace(value).lower()


def normalize_ascii_lower(value: str | None) -> str:
    """Trim, accents retires, minuscules : utilise pour comparer des mots-cles
    saisis librement (ex: 'résident', 'Resident', 'RESIDENT') a une liste fixe."""
    return strip_accents(str(value or "")).strip().lower()
