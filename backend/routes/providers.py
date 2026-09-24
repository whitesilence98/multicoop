"""Provider utilities.

Two concerns live here:
  1. Saved provider PROFILES — named API connections (Anthropic key, Ollama
     cloud, local Ollama, OpenRouter, ...) that agents can be assigned to.
     CRUD under /api/providers/profiles. The api_key is stored server-side
     and never returned in full (masked preview only).
  2. Live model-catalog discovery — POST /api/providers/fetch-models and
     /api/providers/test, both accepting raw {base_url, api_key} so the
     settings/connections UIs can test unsaved changes.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy import update as sa_update

# Same compat import as client.py — the SDK may pair with the httpx2 fork,
# whose exception classes differ from stock httpx.
try:
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:
    import httpx  # type: ignore[no-redef]

from backend.client import make_httpx_client

log = logging.getLogger("aiemployer.providers")

router = APIRouter(prefix="/api/providers", tags=["providers"])

PROVIDER_KINDS = ("anthropic", "openai_compatible", "ollama", "custom")


# ---- schemas -------------------------------------------------------------------

class FetchModelsIn(BaseModel):
    base_url: str
    api_key: str | None = None    # optional — Ollama etc. need none


class GenericTestIn(BaseModel):
    base_url: str
    api_key: str | None = None


class ModelList(BaseModel):
    models: list[str]
    url: str = ""
    detail: str = ""


class TestResult(BaseModel):
    ok: bool
    latency_ms: int | None = None
    status_code: int | None = None
    detail: str = ""


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: str = Field(default="anthropic", pattern="^(" + "|".join(PROVIDER_KINDS) + ")$")
    base_url: str = ""
    api_key: str | None = None    # None/empty => keep existing (update only)
    default_model: str = ""
    added_models: list[str] | None = None
    is_default: bool = False


class ProviderOut(BaseModel):
    id: int
    name: str
    kind: str
    base_url: str
    default_model: str
    added_models: list[str]
    is_default: bool
    has_api_key: bool
    api_key_preview: str


# ---- helpers -------------------------------------------------------------------

def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 10:
        return key[:2] + "…" + key[-2:]
    return key[:8] + "…" + key[-4:]


def _p_dict(p) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "kind": p.kind,
        "base_url": p.base_url,
        "default_model": p.default_model,
        "added_models": list(p.added_models or []),
        "is_default": bool(p.is_default),
        "has_api_key": bool(p.api_key),
        "api_key_preview": _mask(p.api_key or ""),
    }


def _clean_models(models: list[str] | None) -> list[str]:
    """Dedupe + drop empties; order preserved for stable UI rendering."""
    if models is None:
        return []
    seen: set[str] = set()
    return [m for m in (x.strip() for x in models) if m and not (m in seen or seen.add(m))]


def models_url(base_url: str) -> str:
    """Standardize a base URL into its /models catalog URL.

    https://ollama.com/v1        -> https://ollama.com/v1/models
    https://ollama.com/v1/       -> https://ollama.com/v1/models
    https://ollama.com/v1/models -> unchanged
    https://ollama.com           -> https://ollama.com/v1/models
    """
    url = base_url.strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/models"):
        return url
    if url.endswith("/v1"):
        return url + "/models"
    return url + "/v1/models"


def _parse_models(payload: httpx.Response) -> list[str]:
    """Accept the standard OpenAI shape {"data": [{"id": ...}]}, raw lists,
    and {"models": [...]} variants. Items may be strings or objects."""
    items = payload.json()
    if isinstance(items, dict):
        items = items.get("data") or items.get("models") or []
    ids: list[str] = []
    if isinstance(items, list):
        for m in items:
            if isinstance(m, str):
                ids.append(m)
            elif isinstance(m, dict):
                mid = m.get("id") or m.get("name") or ""
                if mid:
                    ids.append(str(mid))
    return sorted(set(ids))


async def _key_from_env(stored_api_key: str = "") -> str:
    """Key resolution: explicit -> stored -> env (OLLAMA_API_KEY, then
    ANTHROPIC_API_KEY). Ollama-style open endpoints ignore the header, so
    an absent key is still fine for those."""
    return (
        stored_api_key.strip()
        or (os.environ.get("OLLAMA_API_KEY") or "").strip()
        or (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    )


async def _proxy_settings() -> dict:
    """Saved runtime settings that affect outbound diagnostics (proxy only)."""
    from backend.routes.settings import _load_raw
    from backend.main import db

    stored = await _load_raw(db)
    return stored if stored.get("proxy") else {}


async def _ping(url: str, key: str, proxy_settings: dict) -> TestResult:
    """Shared connection test: GET /v1/models with both auth header styles."""
    started = time.monotonic()
    try:
        async with make_httpx_client(proxy_settings) as hx:
            headers = {
                "x-api-key": key,
                "Authorization": f"Bearer {key}",
                "anthropic-version": "2023-06-01",
            }
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


# ---- saved profiles CRUD ---------------------------------------------------------

@router.get("/profiles", response_model=list[ProviderOut])
async def list_profiles() -> list[ProviderOut]:
    from backend.main import db
    from backend.db import Provider

    async with db.session() as s:
        rows = (await s.execute(select(Provider).order_by(Provider.id))).scalars().all()
    return [ProviderOut(**_p_dict(p)) for p in rows]


@router.post("/profiles", response_model=ProviderOut, status_code=201)
async def create_profile(body: ProviderIn) -> ProviderOut:
    from backend.main import db
    from backend.db import Provider

    async with db.session() as s:
        p = Provider(
            name=body.name.strip(),
            kind=body.kind,
            base_url=body.base_url.strip(),
            api_key=(body.api_key or "").strip(),
            default_model=body.default_model.strip(),
            added_models=_clean_models(body.added_models),
            is_default=body.is_default,
        )
        if body.is_default:
            await s.execute(sa_update(Provider).values(is_default=False))
        s.add(p)
        await s.commit()
        return ProviderOut(**_p_dict(p))


@router.patch("/profiles/{provider_id}", response_model=ProviderOut)
async def update_profile(provider_id: int, body: ProviderIn) -> ProviderOut:
    from backend.main import db
    from backend.db import Provider

    async with db.session() as s:
        p = await s.get(Provider, provider_id)
        if not p:
            raise HTTPException(404, "provider not found")
        p.name = body.name.strip()
        p.kind = body.kind
        p.base_url = body.base_url.strip()
        if body.api_key is not None and body.api_key.strip():
            p.api_key = body.api_key.strip()  # empty => keep stored key
        p.default_model = body.default_model.strip()
        if body.added_models is not None:
            p.added_models = _clean_models(body.added_models)
        if body.is_default and not p.is_default:
            p.is_default = True
            await s.execute(
                sa_update(Provider).where(Provider.id != provider_id).values(is_default=False)
            )
        await s.commit()
        return ProviderOut(**_p_dict(p))


@router.delete("/profiles/{provider_id}")
async def delete_profile(provider_id: int) -> dict[str, str]:
    """Delete a profile; agents assigned to it fall back to the runtime
    connection instead of holding a dangling reference."""
    from backend.main import db
    from backend.db import Agent, Provider
    from sqlalchemy import update

    async with db.session() as s:
        p = await s.get(Provider, provider_id)
        if p:
            await s.delete(p)
        await s.execute(
            update(Agent).where(Agent.provider_id == str(provider_id)).values(provider_id="default")
        )
        await s.commit()
    return {"status": "deleted"}


# ---- seeding ---------------------------------------------------------------------

def seed_from_env(db) -> None:
    """One-time seed: turn credentials found in the environment into starter
    provider profiles so the connections list is never empty on first run.
    Runs at startup before requests; wrapped in its own session."""
    import asyncio

    from backend.db import Provider

    candidates: list[dict] = []
    if (os.environ.get("ANTHROPIC_API_KEY") or "").strip():
        base = (os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").strip()
        candidates.append({
            "name": "Anthropic (env)",
            "kind": "anthropic",
            "base_url": base,
            "api_key": os.environ["ANTHROPIC_API_KEY"].strip(),
            "is_default": True,
        })
    if (os.environ.get("OLLAMA_API_KEY") or "").strip():
        candidates.append({
            "name": "Ollama Cloud (env)",
            "kind": "ollama",
            "base_url": "https://ollama.com",
            "api_key": os.environ["OLLAMA_API_KEY"].strip(),
        })
    # Local Ollama needs no key and is the classic "Local" connection.
    candidates.append({
        "name": "Local Ollama",
        "kind": "ollama",
        "base_url": "http://localhost:11434",
        "api_key": "",
    })

    async def _go() -> None:
        async with db.session() as s:
            existing = (await s.execute(select(Provider))).scalars().all()
            have = {p.name for p in existing}
            added = False
            for c in candidates:
                if c["name"] in have:
                    continue
                s.add(Provider(**c))
                added = True
            if added:
                await s.commit()
                log.info("seeded %d provider profile(s) from env", len(candidates))

    try:
        asyncio.get_running_loop().create_task(_go())
    except RuntimeError:
        asyncio.run(_go())


# ---- diagnostics (unsaved-changes testable) --------------------------------------

@router.post("/fetch-models", response_model=ModelList)
async def fetch_models(body: FetchModelsIn) -> ModelList:
    url = models_url(body.base_url)
    if not url:
        return ModelList(models=[], detail="base_url required")

    key = await _key_from_env(body.api_key or "")
    headers: dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        async with make_httpx_client(await _proxy_settings()) as hx:
            resp = await hx.get(url, headers=headers)
    except httpx.ConnectError as e:
        return ModelList(models=[], url=url, detail=f"connection failed: {e}")
    except httpx.ConnectTimeout:
        return ModelList(models=[], url=url, detail="connection timed out")
    except httpx.ProxyError as e:
        return ModelList(models=[], url=url, detail=f"proxy error: {e}")
    except httpx.HTTPError as e:
        return ModelList(models=[], url=url, detail=f"{type(e).__name__}: {e}")

    if resp.status_code in (401, 403):
        return ModelList(models=[], url=url, detail="missing or invalid api key")
    if resp.status_code != 200:
        return ModelList(models=[], url=url, detail=f"HTTP {resp.status_code}: {resp.text[:200]}")

    try:
        return ModelList(models=_parse_models(resp), url=url)
    except ValueError:
        return ModelList(models=[], url=url, detail="endpoint did not return JSON")


@router.post("/test", response_model=TestResult)
async def test_connection(body: GenericTestIn) -> TestResult:
    """Ping an unsaved endpoint/key combo. No key falls back to env creds."""
    url = models_url(body.base_url)
    if not url:
        raise HTTPException(400, "base_url required")
    key = await _key_from_env(body.api_key or "")
    return await _ping(url, key, await _proxy_settings())