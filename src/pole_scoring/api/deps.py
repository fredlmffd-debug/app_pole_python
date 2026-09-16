from __future__ import annotations

from fastapi import Request

from ..db.connection import Database, get_db
from ..services import access as access_service


def get_database(request: Request) -> Database:  # noqa: ARG001 - garde la signature FastAPI Depends
    return get_db()


def get_access_token(request: Request) -> str:
    return str(request.headers.get("x-access-token") or "").strip()


def get_current_access_account(request: Request, db: Database) -> dict | None:
    return access_service.get_current_access_account(db, get_access_token(request))


def require_access_account(request: Request, db: Database, allowed_roles: list[str] | None = None) -> dict:
    account = get_current_access_account(request, db)

    if not account:
        raise ValueError("Authentification requise")

    if allowed_roles and account["role"] not in allowed_roles:
        raise ValueError("Accès refusé")

    return account


def _is_loopback_address(address: str | None) -> bool:
    normalized = str(address or "").strip().replace("::ffff:", "")
    return normalized in ("127.0.0.1", "::1")


def require_local_system_control(request: Request) -> None:
    """Equivalent de requireLocalSystemControl (server.js) : certaines actions
    (export PDF, ouverture d'un dossier local) ne doivent etre declenchables
    que depuis le poste local, jamais depuis une tablette juge sur le LAN."""
    remote_address = request.client.host if request.client else None

    if not _is_loopback_address(remote_address):
        raise ValueError("Commande autorisée uniquement depuis le poste local")
