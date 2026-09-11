from __future__ import annotations

from pole_scoring.db.connection import Database
from pole_scoring.db.settings import (
    get_node_id,
    get_setting,
    set_setting,
    set_competition_include_shadow_tablet_judges,
)
from pole_scoring.utils.time import now


def test_setting_roundtrip(db: Database) -> None:
    assert get_setting(db, "missing") is None
    set_setting(db, "foo", "bar")
    assert get_setting(db, "foo") == "bar"
    set_setting(db, "foo", "baz")
    assert get_setting(db, "foo") == "baz"


def test_node_id_is_created_once_and_stable(db: Database) -> None:
    first = get_node_id(db)
    second = get_node_id(db)
    assert first == second
    assert len(first) == 36


def test_set_shadow_tablet_judges_requires_existing_competition(db: Database) -> None:
    try:
        set_competition_include_shadow_tablet_judges(db, "missing", True)
        assert False, "should have raised"
    except ValueError:
        pass

    db.execute(
        "INSERT INTO competitions (id, name, status, created_at, updated_at) VALUES ('comp-1', 'Test', 'draft', ?, ?)",
        (now(), now()),
    )

    result = set_competition_include_shadow_tablet_judges(db, "comp-1", True)
    assert result == {"competitionId": "comp-1", "includeShadowTabletJudges": True}
