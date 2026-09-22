"""Dynamic API client factory.

Builds Anthropic / httpx clients from the user's runtime settings (API key,
base URL, proxy, timeout, retries). The orchestrator holds a reference to the
*current* client and rebuilds it whenever settings change, so agent runs
always pick up the active configuration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# The installed Anthropic SDK may pair with httpx2 (a drop-in fork) rather
# than stock httpx — prefer it when present so Timeout instances validate.
try:
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:
    import httpx  # type: ignore[no-redef]

from anthropic import AsyncAnthropic


@dataclass
class ProxyConfig:
    protocol: str          # http | https | socks5
    host: str
    port: int
    username: str = ""
    password: str = ""

    def url(self) -> str:
        auth = f"{self.username}:{self.password}@" if self.username else ""
        return f"{self.protocol}://{auth}{self.host}:{self.port}"


def build_httpx_args(settings: dict[str, Any]) -> dict[str, Any]:
    """Translate settings into httpx.AsyncClient / SDK constructor kwargs."""
    args: dict[str, Any] = {}

    base_url = (settings.get("base_url") or "").strip()
    if base_url:
        # The Anthropic SDK appends /v1/messages itself; a user-entered
        # base_url that already ends in /v1 would double the prefix
        # (/v1/v1/messages → 404). Strip it — /models fetchers re-add it.
        base_url = base_url.rstrip("/")
        if base_url.endswith("/v1"):
            base_url = base_url[: -len("/v1")]
        args["base_url"] = base_url

    api_key = (settings.get("api_key") or "").strip()
    if not api_key:
        # Credential fallbacks: settings panel key first, then env vars
        # (OLLAMA_API_KEY for Ollama cloud, ANTHROPIC_API_KEY last).
        import os

        api_key = (
            os.environ.get("OLLAMA_API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
            or ""
        ).strip()
    if api_key:
        args["api_key"] = api_key
        # Non-Anthropic gateways (Ollama cloud, OpenAI-compatible proxies) read
        # the credential from "Authorization: Bearer", not the SDK's x-api-key
        # header. Sending Bearer to those, x-api-key to Anthropic proper.
        base = (settings.get("base_url") or "").strip().rstrip("/")
        if base and "anthropic.com" not in base:
            args["default_headers"] = {"Authorization": f"Bearer {api_key}"}

    timeout = settings.get("timeout_seconds")
    if timeout_seconds := (timeout if isinstance(timeout, (int, float)) else None):
        # Connect timeout smaller than total read/write timeout.
        args["timeout"] = httpx.Timeout(float(timeout), connect=min(10.0, float(timeout) / 2))

    proxy = settings.get("proxy") or {}
    if proxy.get("enabled"):
        p = ProxyConfig(
            protocol=proxy.get("protocol") or "http",
            host=proxy.get("host") or "",
            port=int(proxy.get("port") or 0),
            username=proxy.get("username") or "",
            password=proxy.get("password") or "",
        )
        if p.host and p.port:
            args["proxy"] = p.url()

    return args


def make_client(settings: dict[str, Any] | None = None) -> AsyncAnthropic:
    """Instantiate an AsyncAnthropic honoring custom key/base-url/proxy.

    The SDK's built-in retries stay disabled (agent_runner owns retry/backoff),
    but the user-configured retry count is honored for the diagnostics ping.
    """
    kwargs = build_httpx_args(settings or {})
    kwargs["max_retries"] = 0  # we own pacing; retries apply to test-connection only
    return AsyncAnthropic(**kwargs)


def make_httpx_client(settings: dict[str, Any] | None = None) -> httpx.AsyncClient:
    """Raw httpx client honoring base_url + proxy — used by the test ping."""
    kwargs = build_httpx_args(settings or {})
    kwargs.pop("api_key", None)  # httpx has no api_key param
    kwargs.setdefault("timeout", 15.0)
    return httpx.AsyncClient(**kwargs)