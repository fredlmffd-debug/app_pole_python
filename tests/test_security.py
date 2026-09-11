from __future__ import annotations

import hashlib

from pole_scoring.utils.security import (
    RECOVERY_CODE_ALPHABET,
    build_recovery_code_hint,
    generate_recovery_code,
    generate_temporary_password,
    hash_competition_delete_password,
    hash_password,
    hash_recovery_code,
    normalize_recovery_code,
    normalize_recovery_code_count,
)


def test_hash_password_matches_sha256_hex() -> None:
    assert hash_password("secret") == hashlib.sha256(b"secret").hexdigest()


def test_hash_competition_delete_password_empty_stays_empty() -> None:
    assert hash_competition_delete_password("") == ""
    assert hash_competition_delete_password("   ") == ""
    assert hash_competition_delete_password("1234") == hash_password("1234")


def test_normalize_recovery_code_strips_and_uppercases() -> None:
    assert normalize_recovery_code("ab12-cd34") == "AB12CD34"
    assert normalize_recovery_code(None) == ""


def test_hash_recovery_code_matches_normalized_hash() -> None:
    assert hash_recovery_code("ab12-cd34") == hash_password("AB12CD34")
    assert hash_recovery_code("") == ""


def test_generate_recovery_code_format() -> None:
    code = generate_recovery_code()
    prefix, _, suffix = code.partition("-")
    assert len(prefix) == 4
    assert len(suffix) == 4
    assert all(ch in RECOVERY_CODE_ALPHABET for ch in prefix + suffix)


def test_build_recovery_code_hint_masks_middle() -> None:
    assert build_recovery_code_hint("AB12-CD34") == "AB••••34"
    assert build_recovery_code_hint("A1") == "••••"


def test_normalize_recovery_code_count_clamps_range() -> None:
    assert normalize_recovery_code_count(None) == 8
    assert normalize_recovery_code_count(2) == 4
    assert normalize_recovery_code_count(99) == 12
    assert normalize_recovery_code_count(6) == 6


def test_generate_temporary_password_format() -> None:
    password = generate_temporary_password()
    parts = password.split("-")
    assert [len(part) for part in parts] == [5, 5, 4]
