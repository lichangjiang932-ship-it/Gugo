"""HTTP primitives for the dependency-free Gugo Python SDK."""

from __future__ import annotations

from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener


class RedirectDenied(Exception):
    """Raised before a cross-origin redirect can receive SDK credentials."""


def _origin(raw_url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(raw_url)
    port = parsed.port
    if port is None:
        port = 443 if parsed.scheme == "https" else 80 if parsed.scheme == "http" else None
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), port


def parse_sse_frame(lines: list[str]) -> tuple[str, str] | None:
    event_type = "message"
    data: list[str] = []
    for line in lines:
        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    return (event_type, "\n".join(data)) if data else None


class SameOriginRedirectHandler(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> Request | None:
        if _origin(req.full_url) != _origin(newurl):
            raise RedirectDenied("Cross-origin SDK redirect denied")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_safe_opener():
    return build_opener(SameOriginRedirectHandler())


__all__ = [
    "RedirectDenied", "SameOriginRedirectHandler", "build_safe_opener", "parse_sse_frame",
]
