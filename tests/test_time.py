from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from pole_scoring.utils.time import next_timestamp_after, now

ISO_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_now_matches_js_toisostring_format() -> None:
    assert ISO_PATTERN.match(now())


def test_next_timestamp_after_empty_reference_returns_now() -> None:
    before = datetime.now(timezone.utc)
    result = next_timestamp_after("")
    parsed = datetime.fromisoformat(result.replace("Z", "+00:00"))
    # now() tronque a la milliseconde (comme toISOString cote JS) : on tolere
    # la perte de precision sous-milliseconde de `before`.
    assert parsed >= before - timedelta(milliseconds=1)


def test_next_timestamp_after_past_reference_returns_now() -> None:
    past_reference = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    result = next_timestamp_after(past_reference)
    parsed = datetime.fromisoformat(result.replace("Z", "+00:00"))
    assert parsed > datetime.fromisoformat(past_reference.replace("Z", "+00:00"))


def test_next_timestamp_after_future_reference_adds_one_millisecond() -> None:
    future_reference = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    result = next_timestamp_after(future_reference)
    parsed_reference = datetime.fromisoformat(future_reference.replace("Z", "+00:00"))
    parsed_result = datetime.fromisoformat(result.replace("Z", "+00:00"))
    assert parsed_result == parsed_reference + timedelta(milliseconds=1)
