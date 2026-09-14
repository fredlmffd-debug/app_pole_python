from __future__ import annotations

import pytest

from pole_scoring.db.connection import Database
from pole_scoring.services import access as access_service


def test_bootstrap_super_admin_then_login(db: Database) -> None:
    session = access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )

    assert session["account"]["role"] == "super_admin"
    assert session["token"]

    login_session = access_service.authenticate_access_account(db, login="admin", password="secret123")
    assert login_session["account"]["id"] == session["account"]["id"]


def test_bootstrap_refuses_when_accounts_exist(db: Database) -> None:
    access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )

    with pytest.raises(ValueError):
        access_service.bootstrap_super_admin_access_account(
            db, first_name="Autre", last_name="Admin", login="autre", password="secret123"
        )


def test_login_rejects_wrong_password(db: Database) -> None:
    access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )

    with pytest.raises(ValueError):
        access_service.authenticate_access_account(db, login="admin", password="wrong")


def test_token_roundtrip_and_logout(db: Database) -> None:
    session = access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )
    token = session["token"]

    resolved = access_service.get_current_access_account(db, token)
    assert resolved["login"] == "admin"

    access_service.invalidate_access_session(db, token)
    assert access_service.get_current_access_account(db, token) is None


def test_super_admin_cannot_be_downgraded_below_one(db: Database) -> None:
    session = access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )
    account_id = session["account"]["id"]

    with pytest.raises(ValueError):
        access_service.update_access_account(
            db,
            account_id=account_id,
            first_name="Admin",
            last_name="Principal",
            login="admin",
            role="presenter",
        )


def test_recovery_code_flow(db: Database) -> None:
    session = access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )
    account_id = session["account"]["id"]

    generated = access_service.generate_access_recovery_codes(db, account_id=account_id, count=4)
    assert generated["generatedCount"] == 4
    plain_code = generated["generatedCodes"][0]["code"]

    recovery_session = access_service.authenticate_access_recovery_code(db, login="admin", code=plain_code)
    assert recovery_session["account"]["mustChangePassword"] is True

    # Le meme code ne doit plus etre utilisable une seconde fois.
    with pytest.raises(ValueError):
        access_service.authenticate_access_recovery_code(db, login="admin", code=plain_code)


def test_create_account_rejects_duplicate_login(db: Database) -> None:
    access_service.create_access_account(
        db, first_name="A", last_name="B", login="juge1", password="secret123", role="admin"
    )

    with pytest.raises(ValueError):
        access_service.create_access_account(
            db, first_name="C", last_name="D", login="juge1", password="secret456", role="admin"
        )
