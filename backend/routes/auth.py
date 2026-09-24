"""Auth API: a simple password gate for the app UI.

Local desktop tool, not multi-user SaaS: one password, stored salted in the
runtime settings row (SQLite, key='runtime', same as routes/settings.py).
A login mints a random hex token kept in memory (30-day lazy expiry); the
token is a UI gate only — no other endpoint enforces it, because the
backend binds to localhost and the token dies on backend restart anyway.
The hash/salt/password is NEVER returned in any response.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("aiemployer.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

# pbkdf2 cost — deliberately modest: this gates a local UI, not a bank vault,
# and keeps first-login latency negligible.
_ITERATIONS = 100_000
_TOKEN_TTL_SECONDS = 30 * 24 * 3600  # 30 days

# Module-level token registry: token hex -> expiry epoch. In-memory only, so
# every backend restart invalidates all sessions (acceptable for this app).
valid_tokens: dict[str, float] = {}


# ---- schemas -------------------------------------------------------------------

class AuthStatus(BaseModel):
    configured: bool


class PasswordIn(BaseModel):
    password: str = Field(min_length=4)


class TokenOut(BaseModel):
    token: str


class TokenIn(BaseModel):
    token: str


class ValidOut(BaseModel):
    valid: bool


# ---- helpers -------------------------------------------------------------------

async def _load_runtime() -> dict:
    from backend.main import db
    from backend.routes.settings import _load_raw

    return await _load_raw(db)


async def _save_runtime(data: dict) -> None:
    from backend.main import db
    from backend.routes.settings import _save_raw

    await _save_raw(db, data)


def _hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _ITERATIONS
    ).hex()


def _mint_token() -> str:
    token = secrets.token_hex(32)
    valid_tokens[token] = time.time() + _TOKEN_TTL_SECONDS
    # Opportunistic sweep of lazily-expired tokens.
    now = time.time()
    for t in [t for t, exp in valid_tokens.items() if exp < now]:
        valid_tokens.pop(t, None)
    return token


# ---- routes ---------------------------------------------------------------------

@router.post("/status", response_model=AuthStatus)
async def auth_status() -> AuthStatus:
    """Is a password configured? (True => show the login form, not setup.)"""
    try:
        stored = await _load_runtime()
        return AuthStatus(configured=bool(stored.get("auth_password_hash")))
    except Exception as e:  # noqa: BLE001
        log.exception("auth status check failed")
        raise HTTPException(500, f"could not read auth status: {e}")


@router.post("/setup", status_code=201)
async def auth_setup(body: PasswordIn) -> AuthStatus:
    """First-use: set the password. 409 if one is already configured."""
    stored = await _load_runtime()
    if stored.get("auth_password_hash"):
        raise HTTPException(409, "password already configured")
    salt = secrets.token_hex(16)
    try:
        stored["auth_password_hash"] = _hash_password(body.password, salt)
        stored["auth_salt"] = salt
        stored["auth_iterations"] = _ITERATIONS
        await _save_runtime(stored)
    except Exception as e:  # noqa: BLE001
        log.exception("auth setup failed")
        raise HTTPException(500, f"could not save password: {e}")
    log.info("auth password configured")
    return AuthStatus(configured=True)


@router.post("/login", response_model=TokenOut)
async def auth_login(body: PasswordIn) -> TokenOut:
    """Verify the password; mint a session token on success, 401 otherwise."""
    stored = await _load_runtime()
    expected = stored.get("auth_password_hash")
    salt = stored.get("auth_salt") or ""
    if not expected or not salt:
        raise HTTPException(401, "no password configured")
    try:
        candidate = _hash_password(body.password, salt)
    except Exception as e:  # noqa: BLE001
        log.exception("auth hash failed")
        raise HTTPException(500, f"login error: {e}")
    # Constant-time compare so timing doesn't leak the hash prefix.
    if not secrets.compare_digest(candidate, expected):
        raise HTTPException(401, "wrong password")
    return TokenOut(token=_mint_token())


@router.post("/validate", response_model=ValidOut)
async def auth_validate(body: TokenIn) -> ValidOut:
    """Lazy token check — lets the UI drop dead sessions after expiry."""
    exp = valid_tokens.get(body.token)
    if exp is None:
        return ValidOut(valid=False)
    if exp < time.time():
        valid_tokens.pop(body.token, None)
        return ValidOut(valid=False)
    return ValidOut(valid=True)


@router.post("/logout", response_model=ValidOut)
async def auth_logout(body: TokenIn) -> ValidOut:
    """Invalidate one token server-side (the UI also drops its copy)."""
    valid_tokens.pop(body.token, None)
    return ValidOut(valid=False)