from __future__ import annotations

import hashlib
import re
import secrets

RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
RECOVERY_CODE_DEFAULT_COUNT = 8
RECOVERY_CODE_MIN_COUNT = 4
RECOVERY_CODE_MAX_COUNT = 12


def hash_password(value: str) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def hash_competition_delete_password(value: str | None) -> str:
    normalized_value = str(value or "").strip()
    return hash_password(normalized_value) if normalized_value else ""


def normalize_recovery_code(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def hash_recovery_code(value: str | None) -> str:
    normalized_code = normalize_recovery_code(value)
    return hash_password(normalized_code) if normalized_code else ""


def _random_alphabet_characters(length: int) -> str:
    return "".join(secrets.choice(RECOVERY_CODE_ALPHABET) for _ in range(length))


def generate_recovery_code() -> str:
    return f"{_random_alphabet_characters(4)}-{_random_alphabet_characters(4)}"


def build_recovery_code_hint(code: str | None) -> str:
    normalized_code = normalize_recovery_code(code)

    if len(normalized_code) < 4:
        return "••••"

    return f"{normalized_code[:2]}••••{normalized_code[-2:]}"


def normalize_recovery_code_count(value: object) -> int:
    try:
        parsed_value = int(str(value).strip())
    except (TypeError, ValueError):
        return RECOVERY_CODE_DEFAULT_COUNT

    return min(max(parsed_value, RECOVERY_CODE_MIN_COUNT), RECOVERY_CODE_MAX_COUNT)


def generate_temporary_password() -> str:
    return f"{_random_alphabet_characters(5)}-{_random_alphabet_characters(5)}-{_random_alphabet_characters(4)}"
