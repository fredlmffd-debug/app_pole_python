from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..db.connection import Database
from ..services import access as access_service
from ..utils.validation import require_string
from .deps import get_access_token, get_database, require_access_account

router = APIRouter(prefix="/api/access")


@router.get("/status")
def get_status(request: Request, db: Database = Depends(get_database)) -> dict:
    return access_service.get_access_status(db, get_access_token(request))


@router.post("/bootstrap-super-admin", status_code=201)
async def bootstrap_super_admin(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return access_service.bootstrap_super_admin_access_account(
        db,
        first_name=require_string(body.get("firstName"), "firstName"),
        last_name=require_string(body.get("lastName"), "lastName"),
        login=require_string(body.get("login"), "login"),
        password=require_string(body.get("password"), "password"),
    )


@router.post("/login")
async def login(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return access_service.authenticate_access_account(
        db,
        login=require_string(body.get("login"), "login"),
        password=require_string(body.get("password"), "password"),
    )


@router.post("/recovery/login-with-code")
async def login_with_recovery_code(request: Request, db: Database = Depends(get_database)) -> dict:
    body = await request.json()
    return access_service.authenticate_access_recovery_code(
        db,
        login=require_string(body.get("login"), "login"),
        code=require_string(body.get("code"), "code"),
    )


@router.post("/logout")
def logout(request: Request, db: Database = Depends(get_database)) -> dict:
    access_service.invalidate_access_session(db, get_access_token(request))
    return {"ok": True}


@router.post("/change-password")
async def change_password(request: Request, db: Database = Depends(get_database)) -> dict:
    account = require_access_account(request, db)
    body = await request.json()
    return access_service.change_access_password(
        db, account_id=account["id"], new_password=require_string(body.get("newPassword"), "newPassword")
    )


@router.get("/accounts")
def list_accounts(request: Request, db: Database = Depends(get_database)) -> list[dict]:
    require_access_account(request, db, ["admin"])
    return access_service.list_access_accounts(db)


@router.post("/accounts", status_code=201)
async def create_account(request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    body = await request.json()
    return access_service.create_access_account(
        db,
        first_name=require_string(body.get("firstName"), "firstName"),
        last_name=require_string(body.get("lastName"), "lastName"),
        login=require_string(body.get("login"), "login"),
        password=require_string(body.get("password"), "password"),
        role=body.get("role") if isinstance(body.get("role"), str) else "scrutateur",
    )


@router.put("/accounts/{account_id}")
async def update_account(account_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    body = await request.json()
    return access_service.update_access_account(
        db,
        account_id=account_id,
        first_name=require_string(body.get("firstName"), "firstName"),
        last_name=require_string(body.get("lastName"), "lastName"),
        login=require_string(body.get("login"), "login"),
        password=body.get("password") if isinstance(body.get("password"), str) else "",
        role=body.get("role") if isinstance(body.get("role"), str) else "scrutateur",
        is_active=body.get("isActive"),
    )


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    return access_service.delete_access_account(db, account_id)


@router.get("/accounts/{account_id}/recovery-codes")
def get_recovery_codes(account_id: str, request: Request, db: Database = Depends(get_database)) -> list[dict]:
    require_access_account(request, db, ["admin"])
    return access_service.list_access_recovery_codes(db, account_id)


@router.post("/accounts/{account_id}/recovery-codes/regenerate")
async def regenerate_recovery_codes(account_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    body = await request.json()
    return access_service.generate_access_recovery_codes(db, account_id=account_id, count=body.get("count"))


@router.post("/accounts/{account_id}/recovery-codes/revoke")
def revoke_recovery_codes(account_id: str, request: Request, db: Database = Depends(get_database)) -> dict:
    require_access_account(request, db, ["admin"])
    return access_service.revoke_access_recovery_codes(db, account_id)
