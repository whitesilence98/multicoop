"""Settings API: load/save runtime configuration + connection diagnostics.

Settings are persisted in the SQLite DB (single row, key='runtime'). The API
key is never returned in full — GET returns a masked preview and a
`has_api_key` flag; PUT accepts either a new key or None (keep existing).
"""
from __future__ import annotations

import logging
import re
import time
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.client import make_client, make_httpx_client

log = logging.getLogger("aiemployer.settings")

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---- schemas -------------------------------------------------------------------

class ProxyIn(BaseModel):
    enabled: bool = False
    protocol: Literal["http", "https", "socks5"] = "http"
    host: str = ""
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str = ""
    password: str | None = None     # None => keep stored password


class SettingsIn(BaseModel):
    provider: str = "anthropic"     # anthropic | openai_compatible | custom
    api_key: str | None = None      # None/absent => keep existing
    base_url: str = "https://api.anthropic.com"
    model: str = "claude-opus-5"
    timeout_seconds: int = Field(default=120, ge=5, le=600)
    max_retries: int = Field(default=3, ge=0, le=10)
    added_models: list[str] | None = None  # None => keep existing
    proxy: ProxyIn | None = None
    user_color: str | None = None   # chat highlight color for the human user


class SettingsOut(BaseModel):
    provider: str
    base_url: str
    model: str
    timeout_seconds: int
    max_retries: int
    added_models: list[str] = Field(default_factory=list)
    proxy: dict
    user_color: str = "#00FF9D"
    has_api_key: bool
    api_key_preview: str  # e.g. "sk-ant-a…9f2e" — never the full key


class TestResult(BaseModel):
    ok: bool
    latency_ms: int | None = None
    status_code: int | None = None
    detail: str = ""


# ---- helpers -------------------------------------------------------------------

def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 10:
        return key[:2] + "…" + key[-2:]
    return key[:8] + "…" + key[-4:]


async def _load_raw(db) -> dict:
    from backend.db import Setting

    async with db.session() as s:
        row = await s.get(Setting, "runtime")
        return (row.value if row else {}) or {}


async def _save_raw(db, data: dict) -> None:
    from backend.db import Setting

    async with db.session() as s:
        existing = await s.get(Setting, "runtime")
        if existing:
            existing.value = data
        else:
            s.add(Setting(key="runtime", value=data))
        await s.commit()


def _resolved(settings: dict, incoming: SettingsIn) -> dict:
    """Merge incoming form data over stored settings, honoring 'keep' semantics."""
    out = dict(settings)
    out["provider"] = incoming.provider
    out["base_url"] = incoming.base_url
    out["model"] = incoming.model
    out["timeout_seconds"] = incoming.timeout_seconds
    out["max_retries"] = incoming.max_retries
    if incoming.added_models is not None:
        # Dedupe + drop empties; order preserved for stable UI rendering.
        seen: set[str] = set()
        out["added_models"] = [
            m for m in (x.strip() for x in incoming.added_models)
            if m and not (m in seen or seen.add(m))
        ]
    if incoming.api_key is not None and incoming.api_key.strip():
        out["api_key"] = incoming.api_key.strip()
    if incoming.proxy is not None:
        proxy = dict(out.get("proxy") or {})
        proxy["enabled"] = incoming.proxy.enabled
        proxy["protocol"] = incoming.proxy.protocol
        proxy["host"] = incoming.proxy.host
        if incoming.proxy.port is not None:
            proxy["port"] = incoming.proxy.port
        proxy["username"] = incoming.proxy.username
        if incoming.proxy.password is not None:
            proxy["password"] = incoming.proxy.password
        out["proxy"] = proxy
    if incoming.user_color and re.fullmatch(r"#[0-9a-fA-F]{6}", incoming.user_color.strip()):
        out["user_color"] = incoming.user_color.strip().lower()
    return out


def _to_out(settings: dict) -> SettingsOut:
    key = settings.get("api_key") or ""
    return SettingsOut(
        provider=settings.get("provider", "anthropic"),
        base_url=settings.get("base_url") or "https://api.anthropic.com",
        model=settings.get("model") or "claude-opus-5",
        timeout_seconds=settings.get("timeout_seconds") or 120,
        max_retries=settings.get("max_retries") or 3,
        added_models=list(settings.get("added_models") or []),
        proxy=settings.get("proxy") or {"enabled": False},
        user_color=settings.get("user_color") or "#00FF9D",
        has_api_key=bool(key),
        api_key_preview=_mask(key),
    )


# ---- routes ----------------------------------------------------------------------

@router.get("", response_model=SettingsOut)
async def get_settings() -> SettingsOut:
    from backend.main import db

    return _to_out(await _load_raw(db))


@router.put("", response_model=SettingsOut)
async def save_settings(body: SettingsIn) -> SettingsOut:
    from backend.main import db

    merged = _resolved(await _load_raw(db), body)
    await _save_raw(db, merged)
    log.info("settings saved (provider=%s model=%s)", merged.get("provider"), merged.get("model"))
    return _to_out(merged)


@router.post("/test-connection", response_model=TestResult)
async def test_connection(body: SettingsIn) -> TestResult:
    """Ping the configured endpoint with the provided key/proxy — without
    saving. Uses the form's current values (unsaved changes are testable)."""
    from backend.main import db

    stored = await _load_raw(db)
    import os

    key = (
        (body.api_key or "").strip()
        or (stored.get("api_key") or "").strip()
        or (os.environ.get("OLLAMA_API_KEY") or "").strip()
        or (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    )
    if not key:
        raise HTTPException(400, "no api key provided or saved")

    # Merge over stored settings so proxy password/port 'keep' semantics work,
    # then validate the config compiles to a client before sending traffic.
    settings = _resolved(stored, body)
    try:
        make_client(settings)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"invalid configuration: {e}")

    started = time.monotonic()
    try:
        async with make_httpx_client(settings) as hx:
            # Both auth styles: x-api-key for Anthropic proper, Bearer for
            # Ollama cloud / OpenAI-compatible gateways.
            headers = {
                "x-api-key": key,
                "Authorization": f"Bearer {key}",
                "anthropic-version": "2023-06-01",
            }
            url = (settings.get("base_url") or "https://api.anthropic.com").rstrip("/") + "/v1/models"
            # Client-level timeout applies (httpx2 rejects Timeout objects at
            # the per-request level).
            resp = await hx.get(url, headers=headers)
            latency = int((time.monotonic() - started) * 1000)
            if resp.status_code == 200:
                return TestResult(ok=True, latency_ms=latency, status_code=200, detail="connected")
            if resp.status_code in (401, 403):
                return TestResult(ok=False, status_code=resp.status_code, detail="invalid api key")
            return TestResult(ok=False, status_code=resp.status_code, detail=resp.text[:300])
    except httpx.ConnectError as e:
        return TestResult(ok=False, detail=f"connection failed (check proxy/host): {e}")
    except httpx.ConnectTimeout:
        return TestResult(ok=False, detail="connection timed out (check proxy/host)")
    except httpx.ProxyError as e:
        return TestResult(ok=False, detail=f"proxy error: {e}")
    except httpx.HTTPError as e:
        return TestResult(ok=False, detail=f"{type(e).__name__}: {e}")


class ModelList(BaseModel):
    models: list[str]
    detail: str = ""


@router.post("/models", response_model=ModelList)
async def fetch_models(body: SettingsIn) -> ModelList:
    """Query the provider's live /v1/models endpoint using the form's current
    values — same unsaved-changes-testable semantics as test-connection."""
    from backend.main import db

    stored = await _load_raw(db)
    import os

    key = (
        (body.api_key or "").strip()
        or (stored.get("api_key") or "").strip()
        or (os.environ.get("OLLAMA_API_KEY") or "").strip()
        or (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    )
    if not key:
        raise HTTPException(400, "no api key provided or saved")

    settings = _resolved(stored, body)
    try:
        async with make_httpx_client(settings) as hx:
            headers = {
                "x-api-key": key,
                "Authorization": f"Bearer {key}",
                "anthropic-version": "2023-06-01",
            }
            url = (settings.get("base_url") or "https://api.anthropic.com").rstrip("/") + "/v1/models"
            resp = await hx.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                ids = sorted({m.get("id", "") for m in data if m.get("id")})
                return ModelList(models=ids)
            if resp.status_code in (401, 403):
                return ModelList(models=[], detail="invalid api key")
            return ModelList(models=[], detail=f"HTTP {resp.status_code}: {resp.text[:200]}")
    except httpx.ConnectError as e:
        return ModelList(models=[], detail=f"connection failed (check proxy/host): {e}")
    except httpx.ConnectTimeout:
        return ModelList(models=[], detail="connection timed out (check proxy/host)")
    except httpx.ProxyError as e:
        return ModelList(models=[], detail=f"proxy error: {e}")
    except httpx.HTTPError as e:
        return ModelList(models=[], detail=f"{type(e).__name__}: {e}")