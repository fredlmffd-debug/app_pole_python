from __future__ import annotations

import math
import re


def require_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or value.strip() == "":
        raise ValueError(f"Le champ {field_name} est obligatoire")

    return value.strip()


def require_number(value: object, field_name: str) -> float:
    try:
        parsed_value = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError(f"Le champ {field_name} doit être numérique") from None

    if not math.isfinite(parsed_value):
        raise ValueError(f"Le champ {field_name} doit être numérique")

    return parsed_value


def optional_string(value: object, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def parse_int_like_js(value: object) -> int | None:
    """Reproduit `Number.parseInt(String(value), 10)` cote JS : entier direct,
    troncature pour un flottant (evite le detour par str() qui casserait sur
    "1.0", int() ne parsant pas les flottants ecrits en toutes lettres), sinon
    lecture des premiers chiffres d'une chaine. None si rien n'est parsable
    (equivalent du NaN JS)."""
    if isinstance(value, bool):
        return None

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return int(value) if math.isfinite(value) else None

    match = re.match(r"^\s*[+-]?\d+", str(value if value is not None else ""))
    return int(match.group(0)) if match else None
