from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _format_iso(moment: datetime) -> str:
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def now() -> str:
    """Equivalent de `new Date().toISOString()` cote Node : precision milliseconde,
    suffixe Z, pour rester dans le meme format que les lignes deja ecrites par
    la version Node dans la meme base."""
    return _format_iso(datetime.now(timezone.utc))


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def next_timestamp_after(reference_value: str = "") -> str:
    reference_moment = _parse_iso(reference_value) if reference_value else None
    current_moment = datetime.now(timezone.utc)

    if reference_moment is None or current_moment > reference_moment:
        return _format_iso(current_moment)

    return _format_iso(reference_moment + timedelta(milliseconds=1))
