from __future__ import annotations

import math


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
