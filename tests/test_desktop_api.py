from __future__ import annotations

from pole_scoring.desktop_api import _safe_dimension


def test_safe_dimension_accepts_valid_values() -> None:
    assert _safe_dimension(800, 100) == 800
    assert _safe_dimension("640", 100) == 640


def test_safe_dimension_falls_back_on_invalid_values() -> None:
    assert _safe_dimension(None, 100) == 100
    assert _safe_dimension("not-a-number", 100) == 100
    assert _safe_dimension(0, 100) == 100
    assert _safe_dimension(-5, 100) == 100
