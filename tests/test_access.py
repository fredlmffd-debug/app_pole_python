from __future__ import annotations

import pytest

from pole_scoring.db.bootstrap import run_startup_tasks
from pole_scoring.db.connection import Database
from pole_scoring.services import access as access_service
from pole_scoring.utils.time import now


def test_bootstrap_admin_then_login(db: Database) -> None:
    session = access_service.bootstrap_super_admin_access_account(
        db, first_name="Admin", last_name="Principal", login="admin", password="secret123"
    )

    assert session["account"]["role"] == "admin"
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


def test_last_admin_cannot_be_downgraded(db: Database) -> None:
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
            role="scrutateur",
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


def _insert_legacy_account(db: Database, *, login: str, role: str) -> None:
    timestamp = now()
    db.execute(
        """
        INSERT INTO access_accounts (id, first_name, last_name, login, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, 'Old', 'Account', ?, 'hash', ?, 1, ?, ?)
        """,
        (login, login, role, timestamp, timestamp),
    )


def test_legacy_roles_are_migrated_once_and_idempotently(db: Database) -> None:
    _insert_legacy_account(db, login="old-super-admin", role="super_admin")
    _insert_legacy_account(db, login="old-admin", role="admin")
    _insert_legacy_account(db, login="old-presenter", role="presenter")

    run_startup_tasks(db)

    accounts_by_login = {account["login"]: account for account in access_service.list_access_accounts(db)}
    assert accounts_by_login["old-super-admin"]["role"] == "admin"
    assert accounts_by_login["old-admin"]["role"] == "scrutateur"
    assert accounts_by_login["old-presenter"]["role"] == "scrutateur"

    # Rejouer les taches de demarrage ne doit pas re-degrader le compte
    # devenu 'admin' (piege : 'admin' est a la fois une ancienne et une
    # nouvelle valeur de role, cf. le correctif Node equivalent).
    run_startup_tasks(db)
    accounts_by_login = {account["login"]: account for account in access_service.list_access_accounts(db)}
    assert accounts_by_login["old-super-admin"]["role"] == "admin"
    assert accounts_by_login["old-admin"]["role"] == "scrutateur"
