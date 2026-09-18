from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from ..db.connection import Database
from ..utils.ids import new_id
from ..utils.security import (
    build_recovery_code_hint,
    generate_recovery_code,
    generate_temporary_password,
    hash_password,
    hash_recovery_code,
    normalize_recovery_code_count,
)
from ..utils.time import now

ACCESS_ROLES = {"admin", "scrutateur"}


def normalize_access_role(value: str | None) -> str:
    normalized_value = str(value or "").strip().lower()
    return normalized_value if normalized_value in ACCESS_ROLES else "scrutateur"


def normalize_access_login(value: str | None) -> str:
    return str(value or "").strip().lower()


ACCOUNT_ROW_SELECT = """
SELECT id,
       first_name AS firstName,
       last_name AS lastName,
       login,
       password_hash AS passwordHash,
       COALESCE(temp_password_hash, '') AS tempPasswordHash,
       COALESCE(must_change_password, 0) AS mustChangePassword,
       role,
       is_active AS isActive,
       created_at AS createdAt,
       updated_at AS updatedAt
FROM access_accounts
WHERE {where}
"""


def get_access_account_by_login(db: Database, login: str) -> dict | None:
    return db.query_one(ACCOUNT_ROW_SELECT.format(where="login = ?"), (normalize_access_login(login),))


def get_access_account_by_id(db: Database, account_id: str) -> dict | None:
    return db.query_one(ACCOUNT_ROW_SELECT.format(where="id = ?"), (account_id,))


def list_access_accounts(db: Database) -> list[dict]:
    rows = db.query_all(
        """
        SELECT id,
               first_name AS firstName,
               last_name AS lastName,
               login,
               role,
               is_active AS isActive,
               COALESCE(must_change_password, 0) AS mustChangePassword,
               created_at AS createdAt,
               updated_at AS updatedAt
        FROM access_accounts
        ORDER BY CASE role
          WHEN 'admin' THEN 0
          WHEN 'scrutateur' THEN 1
          ELSE 2
        END, last_name, first_name, login
        """
    )
    return [
        {**row, "isActive": bool(row["isActive"]), "mustChangePassword": bool(row["mustChangePassword"])}
        for row in rows
    ]


def has_access_accounts(db: Database) -> bool:
    return db.query_one("SELECT COUNT(*) AS count FROM access_accounts")["count"] > 0


def create_access_session(db: Database, account_id: str) -> dict:
    account = get_access_account_by_id(db, account_id)

    if not account or not account["isActive"]:
        raise ValueError("Compte d'accès introuvable")

    token = new_id()
    timestamp = now()

    db.execute(
        """
        INSERT INTO access_sessions (id, access_account_id, token_hash, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (new_id(), account_id, hash_password(token), timestamp, timestamp),
    )

    return {
        "token": token,
        "account": {
            "id": account["id"],
            "firstName": account["firstName"],
            "lastName": account["lastName"],
            "login": account["login"],
            "role": account["role"],
            "isActive": bool(account["isActive"]),
            "mustChangePassword": bool(account["mustChangePassword"]),
        },
    }


def get_access_account_from_token(db: Database, token: str | None) -> dict | None:
    normalized_token = str(token or "").strip()

    if not normalized_token:
        return None

    session = db.query_one(
        """
        SELECT s.id AS sessionId,
               s.access_account_id AS accessAccountId,
               s.last_used_at AS lastUsedAt,
               a.id AS accountId,
               a.first_name AS firstName,
               a.last_name AS lastName,
               a.login,
               a.role,
               COALESCE(a.must_change_password, 0) AS mustChangePassword,
               a.is_active AS isActive
        FROM access_sessions s
        INNER JOIN access_accounts a ON a.id = s.access_account_id
        WHERE s.token_hash = ?
        """,
        (hash_password(normalized_token),),
    )

    if not session or not session["isActive"]:
        return None

    db.execute("UPDATE access_sessions SET last_used_at = ? WHERE id = ?", (now(), session["sessionId"]))

    return {
        "id": session["sessionId"],
        "accountId": session["accessAccountId"],
        "account": {
            "id": session["accountId"],
            "firstName": session["firstName"],
            "lastName": session["lastName"],
            "login": session["login"],
            "role": session["role"],
            "isActive": bool(session["isActive"]),
            "mustChangePassword": bool(session["mustChangePassword"]),
        },
    }


def get_current_access_account(db: Database, token: str | None) -> dict | None:
    session = get_access_account_from_token(db, token)
    return session["account"] if session else None


def get_access_status(db: Database, token: str | None) -> dict:
    return {
        "hasAccounts": has_access_accounts(db),
        "currentAccount": get_current_access_account(db, token),
    }


def invalidate_access_session(db: Database, token: str | None) -> bool:
    normalized_token = str(token or "").strip()

    if not normalized_token:
        return False

    cursor = db.execute("DELETE FROM access_sessions WHERE token_hash = ?", (hash_password(normalized_token),))
    return cursor.rowcount > 0


def create_access_account(
    db: Database, *, first_name: str, last_name: str, login: str, password: str, role: str = "scrutateur"
) -> dict:
    normalized_login = normalize_access_login(login)
    normalized_first_name = str(first_name or "").strip()
    normalized_last_name = str(last_name or "").strip()
    normalized_password = str(password or "").strip()
    normalized_role = normalize_access_role(role)

    if not normalized_first_name or not normalized_last_name:
        raise ValueError("Le nom et le prénom sont obligatoires")

    if not normalized_login:
        raise ValueError("Le login est obligatoire")

    if not normalized_password:
        raise ValueError("Le mot de passe est obligatoire")

    if db.query_one("SELECT id FROM access_accounts WHERE login = ?", (normalized_login,)):
        raise ValueError("Ce login existe déjà")

    timestamp = now()
    account_id = new_id()

    db.execute(
        """
        INSERT INTO access_accounts (
          id, first_name, last_name, login, password_hash, temp_password_hash, must_change_password,
          role, is_active, created_at, updated_at
        ) VALUES (
          :id, :first_name, :last_name, :login, :password_hash, :temp_password_hash, :must_change_password,
          :role, :is_active, :created_at, :updated_at
        )
        """,
        {
            "id": account_id,
            "first_name": normalized_first_name,
            "last_name": normalized_last_name,
            "login": normalized_login,
            "password_hash": hash_password(normalized_password),
            "temp_password_hash": "",
            "must_change_password": 0,
            "role": normalized_role,
            "is_active": 1,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )

    return get_access_account_by_id(db, account_id)


def update_access_account(
    db: Database,
    *,
    account_id: str,
    first_name: str,
    last_name: str,
    login: str,
    password: str = "",
    role: str | None = None,
    is_active: bool | None = None,
) -> dict:
    existing = get_access_account_by_id(db, account_id)

    if existing is None:
        raise ValueError("Compte introuvable")

    next_login = normalize_access_login(login)
    next_first_name = str(first_name or "").strip()
    next_last_name = str(last_name or "").strip()
    next_role = normalize_access_role(role if role is not None else existing["role"])
    next_is_active = is_active if isinstance(is_active, bool) else bool(existing["isActive"])

    if not next_first_name or not next_last_name:
        raise ValueError("Le nom et le prénom sont obligatoires")

    if not next_login:
        raise ValueError("Le login est obligatoire")

    duplicate = db.query_one(
        "SELECT id FROM access_accounts WHERE login = ? AND id <> ?", (next_login, account_id)
    )
    if duplicate:
        raise ValueError("Ce login existe déjà")

    timestamp = now()
    has_password_change = bool(str(password or "").strip())
    next_password_hash = hash_password(password) if has_password_change else existing["passwordHash"]

    if existing["role"] == "admin" and next_role != "admin":
        remaining = db.query_one(
            "SELECT COUNT(*) AS count FROM access_accounts WHERE role = 'admin' AND is_active = 1 AND id <> ?",
            (account_id,),
        )["count"]
        if remaining == 0:
            raise ValueError("Au moins un administrateur doit rester actif")

    if existing["role"] == "admin" and not next_is_active:
        remaining_active = db.query_one(
            "SELECT COUNT(*) AS count FROM access_accounts WHERE role = 'admin' AND is_active = 1 AND id <> ?",
            (account_id,),
        )["count"]
        if remaining_active == 0:
            raise ValueError("Au moins un administrateur doit rester actif")

    with db.transaction():
        db.execute(
            """
            UPDATE access_accounts
            SET first_name = ?, last_name = ?, login = ?, password_hash = ?, temp_password_hash = ?,
                must_change_password = ?, role = ?, is_active = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_first_name,
                next_last_name,
                next_login,
                next_password_hash,
                "" if has_password_change else existing["tempPasswordHash"],
                0 if has_password_change else (1 if existing["mustChangePassword"] else 0),
                next_role,
                1 if next_is_active else 0,
                timestamp,
                account_id,
            ),
        )

        if not next_is_active:
            db.execute("DELETE FROM access_sessions WHERE access_account_id = ?", (account_id,))

    return get_access_account_by_id(db, account_id)


def delete_access_account(db: Database, account_id: str) -> dict:
    existing = get_access_account_by_id(db, account_id)

    if existing is None:
        raise ValueError("Compte introuvable")

    if existing["role"] == "admin":
        remaining = db.query_one(
            "SELECT COUNT(*) AS count FROM access_accounts WHERE role = 'admin' AND is_active = 1 AND id <> ?",
            (account_id,),
        )["count"]
        if remaining == 0:
            raise ValueError("Au moins un administrateur doit rester actif")

    with db.transaction():
        db.execute("DELETE FROM access_sessions WHERE access_account_id = ?", (account_id,))
        db.execute("DELETE FROM access_accounts WHERE id = ?", (account_id,))

    return {"deletedAccountId": account_id}


def authenticate_access_account(db: Database, *, login: str, password: str) -> dict:
    account = get_access_account_by_login(db, login)
    normalized_password = str(password or "").strip()
    password_hash = hash_password(normalized_password)

    if not account or not account["isActive"]:
        raise ValueError("Login ou mot de passe invalide")

    has_temporary_password = bool(account["tempPasswordHash"])
    must_change_password = bool(account["mustChangePassword"])

    if must_change_password:
        if not has_temporary_password or account["tempPasswordHash"] != password_hash:
            raise ValueError("Connexion temporaire requise. Utilisez le code de récupération.")
        return create_access_session(db, account["id"])

    if account["passwordHash"] != password_hash:
        raise ValueError("Login ou mot de passe invalide")

    return create_access_session(db, account["id"])


def change_access_password(db: Database, *, account_id: str, new_password: str) -> dict:
    account = get_access_account_by_id(db, account_id)

    if not account or not account["isActive"]:
        raise ValueError("Compte introuvable")

    normalized_password = str(new_password or "").strip()

    if not normalized_password:
        raise ValueError("Le nouveau mot de passe est obligatoire")

    db.execute(
        """
        UPDATE access_accounts
        SET password_hash = ?, temp_password_hash = '', must_change_password = 0, updated_at = ?
        WHERE id = ?
        """,
        (hash_password(normalized_password), now(), account_id),
    )

    return get_access_account_by_id(db, account_id)


def list_access_recovery_codes(db: Database, account_id: str) -> list[dict]:
    if get_access_account_by_id(db, account_id) is None:
        raise ValueError("Compte introuvable")

    return db.query_all(
        """
        SELECT id,
               COALESCE(NULLIF(code_value, ''), code_hint) AS code,
               code_hint AS codeHint,
               status,
               created_at AS createdAt,
               used_at AS usedAt,
               expires_at AS expiresAt
        FROM access_recovery_codes
        WHERE access_account_id = ?
        ORDER BY created_at DESC
        LIMIT 4
        """,
        (account_id,),
    )


def revoke_access_recovery_codes(db: Database, account_id: str) -> dict:
    if get_access_account_by_id(db, account_id) is None:
        raise ValueError("Compte introuvable")

    cursor = db.execute(
        "UPDATE access_recovery_codes SET status = 'revoked' WHERE access_account_id = ? AND status = 'active'",
        (account_id,),
    )

    return {"accountId": account_id, "revokedCount": cursor.rowcount}


def generate_access_recovery_codes(db: Database, *, account_id: str, count: object = None) -> dict:
    if get_access_account_by_id(db, account_id) is None:
        raise ValueError("Compte introuvable")

    normalized_count = normalize_recovery_code_count(count)
    created_at = now()
    generated_codes = []

    with db.transaction():
        db.execute(
            "UPDATE access_recovery_codes SET status = 'revoked' WHERE access_account_id = ? AND status = 'active'",
            (account_id,),
        )

        for _ in range(normalized_count):
            inserted = False
            plain_code = ""

            while not inserted:
                plain_code = generate_recovery_code()
                hashed_code = hash_recovery_code(plain_code)

                try:
                    db.execute(
                        """
                        INSERT INTO access_recovery_codes (
                          id, access_account_id, code_hash, code_value, code_hint, status, created_at, used_at, expires_at
                        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
                        """,
                        (new_id(), account_id, hashed_code, plain_code, build_recovery_code_hint(plain_code), created_at),
                    )
                    inserted = True
                except sqlite3.IntegrityError:
                    inserted = False

            generated_codes.append({"code": plain_code, "codeHint": build_recovery_code_hint(plain_code)})

    return {"accountId": account_id, "generatedCount": len(generated_codes), "generatedCodes": generated_codes}


def authenticate_access_recovery_code(db: Database, *, login: str, code: str) -> dict:
    account = get_access_account_by_login(db, login)

    if not account or not account["isActive"]:
        raise ValueError("Code de récupération invalide")

    code_hash = hash_recovery_code(code)

    if not code_hash:
        raise ValueError("Code de récupération invalide")

    recovery_code = db.query_one(
        """
        SELECT id, status, expires_at AS expiresAt
        FROM access_recovery_codes
        WHERE access_account_id = ? AND code_hash = ? AND status = 'active'
        """,
        (account["id"], code_hash),
    )

    if not recovery_code:
        raise ValueError("Code de récupération invalide")

    if recovery_code["expiresAt"]:
        try:
            expired = datetime.fromisoformat(
                str(recovery_code["expiresAt"]).replace("Z", "+00:00")
            ) < datetime.now(timezone.utc)
        except ValueError:
            expired = False

        if expired:
            db.execute("UPDATE access_recovery_codes SET status = 'revoked' WHERE id = ?", (recovery_code["id"],))
            raise ValueError("Code de récupération expiré")

    temporary_password = generate_temporary_password()
    timestamp = now()

    with db.transaction():
        cursor = db.execute(
            """
            UPDATE access_recovery_codes
            SET status = 'used', used_at = ?
            WHERE id = ? AND access_account_id = ? AND status = 'active'
            """,
            (timestamp, recovery_code["id"], account["id"]),
        )

        if cursor.rowcount != 1:
            raise ValueError("Le code de récupération n'est plus actif")

        db.execute(
            """
            UPDATE access_accounts
            SET temp_password_hash = ?, must_change_password = 1, updated_at = ?
            WHERE id = ?
            """,
            (hash_password(temporary_password), timestamp, account["id"]),
        )

        db.execute("DELETE FROM access_sessions WHERE access_account_id = ?", (account["id"],))

    return create_access_session(db, account["id"])


def bootstrap_super_admin_access_account(
    db: Database, *, first_name: str, last_name: str, login: str, password: str
) -> dict:
    if has_access_accounts(db):
        raise ValueError("Les comptes d'accès existent déjà")

    account = create_access_account(
        db, first_name=first_name, last_name=last_name, login=login, password=password, role="admin"
    )

    return create_access_session(db, account["id"])
