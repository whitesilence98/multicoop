"""Provider utilities: live model catalog discovery from OpenAI-compatible
endpoints (Ollama, OpenRouter, custom proxies).

POST /api/providers/fetch-models {base_url, api_key?}
  -> {"models": ["glm-5.3", ...], "url": "<queried url>", "detail": ""}
"""
from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

# Same compat import as client.py — the SDK may pair with the httpx2 fork,
# whose exception classes differ from stock httpx.
try:
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:
    import httpx  # type: ignore[no-redef]

from backend.client import make_httpx_client

log = logging.getLogger("aiemployer.providers")

router = APIRouter(prefix="/api/providers", tags=["providers"])


# ---- schemas -------------------------------------------------------------------

class FetchModelsIn(BaseModel):
    base_url: str
    api_key: str | None = None    # optional — Ollama etc. need none


class ModelList(BaseModel):
    models: list[str]
    url: str = ""
    detail: str = ""


# ---- helpers -------------------------------------------------------------------

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


# ---- routes ----------------------------------------------------------------------

@router.post("/fetch-models", response_model=ModelList)
async def fetch_models(body: FetchModelsIn) -> ModelList:
    url = models_url(body.base_url)
    if not url:
        return ModelList(models=[], detail="base_url required")

    # Stored settings: API-key fallback + saved proxy config.
    from backend.routes.settings import _load_raw
    from backend.main import db

    stored = await _load_raw(db)

    # Key resolution: form -> stored settings -> env (OLLAMA_API_KEY, then
    # ANTHROPIC_API_KEY). Ollama-style open endpoints ignore the header, so
    # an absent key is still fine for those.
    import os

    key = (
        (body.api_key or "").strip()
        or (stored.get("api_key") or "").strip()
        or (os.environ.get("OLLAMA_API_KEY") or "").strip()
        or (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    )

    headers: dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        async with make_httpx_client(stored if stored.get("proxy") else {}) as hx:
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