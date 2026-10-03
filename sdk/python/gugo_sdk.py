"""Dependency-free Python client for the Gugo HTTP Turn contract v1."""

from __future__ import annotations

import json
import math
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urljoin, urlparse
from urllib.request import Request

try:
    from .gugo_sdk_http import RedirectDenied, build_safe_opener, parse_sse_frame
except ImportError:  # Direct PYTHONPATH usage: `from gugo_sdk import ...`
    from gugo_sdk_http import RedirectDenied, build_safe_opener, parse_sse_frame

GUGO_SDK_CONTRACT_VERSION = 1
GUGO_TURN_TERMINAL_EVENTS = (
    "turn.completed",
    "turn.blocked",
    "turn.paused",
    "turn.cancelled",
    "turn.failed",
    "turn.interrupted",
)
_TERMINAL_EVENTS = frozenset(GUGO_TURN_TERMINAL_EVENTS)
_START_FIELDS = (
    "sessionId",
    "turnId",
    "content",
    "displayContent",
    "workspacePath",
    "locale",
    "modelName",
    "modelProviderId",
    "modelConfigRevision",
    "modelMode",
    "history",
    "agentId",
    "skillIds",
    "skillDefinitions",
    "toolsConfig",
    "intentMode",
    "attachments",
)
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024


class GugoSdkError(Exception):
    """Stable SDK/server error with optional HTTP status and safe details."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = str(code)
        self.status = status
        self.details = details


def _sdk_error(code: str, message: str, **kwargs: Any) -> GugoSdkError:
    return GugoSdkError(code, message, **kwargs)


def _record(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _sdk_error("GUGO_SDK_INPUT_INVALID", f"{label} must be an object")
    return value


def _required_id(value: Any, label: str) -> str:
    identifier = value.strip() if isinstance(value, str) else ""
    if not identifier or len(identifier) > 512:
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID",
            f"{label} must be a non-empty string of at most 512 characters",
        )
    return identifier


def _safe_integer(
    value: Any,
    label: str,
    *,
    minimum: int = 0,
    maximum: int = (2**53) - 1,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID",
            f"{label} must be an integer between {minimum} and {maximum}",
        )
    if value < minimum or value > maximum:
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID",
            f"{label} must be an integer between {minimum} and {maximum}",
        )
    return value


def _bounded_request_timeout(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID",
            "request_timeout must be between 0.1 and 600 seconds",
        )
    timeout = float(value)
    if not math.isfinite(timeout) or timeout < 0.1 or timeout > 600:
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID",
            "request_timeout must be between 0.1 and 600 seconds",
        )
    return timeout


def _project_start_input(value: Any) -> dict[str, Any]:
    source = _record(value, "start_turn input")
    projected = {
        field: source[field]
        for field in _START_FIELDS
        if field in source and source[field] is not None
    }
    projected["sessionId"] = _required_id(source.get("sessionId"), "sessionId")
    content = source.get("content")
    if not isinstance(content, str) or not content.strip():
        raise _sdk_error(
            "GUGO_SDK_INPUT_INVALID", "content must be a non-empty string"
        )
    projected["content"] = content
    return projected


def _error_payload(body: Any, status: int) -> GugoSdkError:
    source = body if isinstance(body, Mapping) else {}
    nested = source.get("error") if isinstance(source.get("error"), Mapping) else None
    code = str(
        (nested or {}).get("code") or source.get("code") or f"HTTP_{status}"
    ).strip() or f"HTTP_{status}"
    raw_error = source.get("error")
    message = str(
        (nested or {}).get("message")
        or (raw_error if isinstance(raw_error, str) else code)
    )
    return _sdk_error(code, message, status=status, details=nested or body)


def _decode_json(data: bytes, *, status: int) -> Mapping[str, Any]:
    try:
        body = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _sdk_error(
            "GUGO_SDK_RESPONSE_INVALID",
            "Gugo returned invalid JSON",
            status=status,
        ) from error
    if not isinstance(body, Mapping):
        raise _sdk_error(
            "GUGO_SDK_RESPONSE_INVALID",
            "Gugo returned a non-object response",
            status=status,
        )
    return body


def _read_bounded(response: Any) -> bytes:
    data = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(data) > _MAX_RESPONSE_BYTES:
        raise _sdk_error(
            "GUGO_SDK_RESPONSE_INVALID", "Gugo response exceeded 8 MiB"
        )
    return data


def _advance_event_cursor(event: Any, cursor: int) -> int:
    if not isinstance(event, Mapping):
        raise _sdk_error("GUGO_SDK_RESPONSE_INVALID", "event must be an object")
    sequence = event.get("sequence")
    compacted_through = event.get("compactedThrough")
    expected = cursor + 1
    sequence_valid = isinstance(sequence, int) and not isinstance(sequence, bool)
    compacted_valid = (
        isinstance(compacted_through, int)
        and not isinstance(compacted_through, bool)
    )
    valid = sequence_valid and (
        sequence == expected
        or (
            sequence > expected
            and compacted_valid
            and sequence <= compacted_through
        )
    )
    if not valid:
        raise _sdk_error(
            "GUGO_SDK_EVENT_SEQUENCE_INVALID",
            f"expected event sequence {expected}",
        )
    return sequence


def _aborted(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise _sdk_error("GUGO_SDK_ABORTED", "Operation aborted")


class GugoClient:
    """Synchronous dependency-free client for Gugo Turn HTTP/SSE APIs."""

    contract_version = GUGO_SDK_CONTRACT_VERSION

    def __init__(
        self,
        *,
        base_url: str,
        token: str = "",
        request_timeout: float = 30.0,
        opener: Any = None,
    ) -> None:
        parsed = urlparse(str(base_url or ""))
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise _sdk_error(
                "GUGO_SDK_INPUT_INVALID",
                "base_url must be an absolute http/https URL without credentials",
            )
        normalized_path = parsed.path.rstrip("/") + "/"
        self._base_url = parsed._replace(path=normalized_path, params="", query="", fragment="").geturl()
        self._token = str(token or "").strip()
        self._request_timeout = _bounded_request_timeout(request_timeout)
        self._opener = opener or build_safe_opener()

    def _headers(self, *, body: bool = False, accept: str = "application/json") -> dict[str, str]:
        headers = {
            "Accept": accept,
            "X-Gugo-SDK-Contract": str(GUGO_SDK_CONTRACT_VERSION),
        }
        if body:
            headers["Content-Type"] = "application/json"
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _url(self, pathname: str, query: Mapping[str, Any] | None = None) -> str:
        url = urljoin(self._base_url, pathname.lstrip("/"))
        if query:
            values = {key: str(value) for key, value in query.items() if value is not None}
            if values:
                url = f"{url}?{urlencode(values)}"
        return url

    def _open(self, request: Request, *, timeout: float | None = None) -> Any:
        effective_timeout = timeout if timeout is not None else self._request_timeout
        try:
            return self._opener.open(request, timeout=effective_timeout)
        except HTTPError as error:
            data = error.read(_MAX_RESPONSE_BYTES + 1)
            if len(data) > _MAX_RESPONSE_BYTES:
                raise _sdk_error(
                    "GUGO_SDK_RESPONSE_INVALID",
                    "Gugo error response exceeded 8 MiB",
                    status=error.code,
                ) from error
            try:
                body = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                body = None
            raise _error_payload(body, error.code) from error
        except RedirectDenied as error:
            raise _sdk_error(
                "GUGO_SDK_REDIRECT_DENIED",
                "Cross-origin SDK redirect denied",
            ) from error
        except TimeoutError as error:
            raise _sdk_error(
                "GUGO_SDK_REQUEST_TIMEOUT",
                f"Gugo request did not complete within {effective_timeout} seconds",
            ) from error
        except URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise _sdk_error(
                    "GUGO_SDK_REQUEST_TIMEOUT",
                    f"Gugo request did not complete within {effective_timeout} seconds",
                ) from error
            raise _sdk_error(
                "GUGO_SDK_NETWORK_ERROR", str(error.reason or error)
            ) from error

    def _request(
        self,
        pathname: str,
        *,
        method: str = "GET",
        body: Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
        request_timeout: float | None = None,
    ) -> Mapping[str, Any]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = Request(
            self._url(pathname, query),
            data=encoded,
            method=method,
            headers=self._headers(body=body is not None),
        )
        with self._open(
            request,
            timeout=(
                _bounded_request_timeout(request_timeout)
                if request_timeout is not None
                else None
            ),
        ) as response:
            status = int(getattr(response, "status", 200))
            payload = _decode_json(_read_bounded(response), status=status)
        if payload.get("ok") is False:
            raise _error_payload(payload, status)
        return payload

    def start_turn(
        self,
        input: Mapping[str, Any],
        *,
        request_timeout: float | None = None,
    ) -> Mapping[str, Any]:
        body = self._request(
            "/api/turns/run",
            method="POST",
            body=_project_start_input(input),
            request_timeout=request_timeout,
        )
        turn = body.get("turn")
        if not isinstance(turn, Mapping) or not (turn.get("id") or turn.get("turnId")):
            raise _sdk_error(
                "GUGO_SDK_RESPONSE_INVALID",
                "start_turn response is missing a Turn identity",
            )
        return turn

    def get_turn(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_timeout: float | None = None,
    ) -> Mapping[str, Any]:
        body = self._request(
            f"/api/turns/{quote(_required_id(turn_id, 'turn_id'), safe='')}",
            query={"sessionId": _required_id(session_id, "session_id")},
            request_timeout=request_timeout,
        )
        turn = body.get("turn")
        if not isinstance(turn, Mapping):
            raise _sdk_error("GUGO_SDK_RESPONSE_INVALID", "turn is missing")
        return turn

    def list_turn_events(
        self,
        *,
        session_id: str,
        turn_id: str,
        after: int = -1,
        limit: int = 500,
        request_timeout: float | None = None,
    ) -> list[Mapping[str, Any]]:
        body = self._request(
            "/api/turns/events",
            query={
                "sessionId": _required_id(session_id, "session_id"),
                "turnId": _required_id(turn_id, "turn_id"),
                "after": _safe_integer(after, "after", minimum=-1),
                "limit": _safe_integer(limit, "limit", minimum=1, maximum=2_000),
            },
            request_timeout=request_timeout,
        )
        events = body.get("events")
        if not isinstance(events, list) or any(not isinstance(event, Mapping) for event in events):
            raise _sdk_error("GUGO_SDK_RESPONSE_INVALID", "events must be an array of objects")
        return events

    def wait_for_terminal(
        self,
        *,
        session_id: str,
        turn_id: str,
        after: int = -1,
        poll_interval_ms: int = 500,
        timeout_ms: int = 20 * 60 * 1_000,
        on_event: Callable[[Mapping[str, Any]], Any] | None = None,
        cancel_event: threading.Event | None = None,
    ) -> Mapping[str, Any]:
        interval = _safe_integer(
            poll_interval_ms, "poll_interval_ms", minimum=10, maximum=60_000
        )
        timeout = _safe_integer(
            timeout_ms,
            "timeout_ms",
            minimum=1_000,
            maximum=6 * 60 * 60 * 1_000,
        )
        cursor = _safe_integer(after, "after", minimum=-1)
        deadline = time.monotonic() + (timeout / 1_000)
        while time.monotonic() < deadline:
            _aborted(cancel_event)
            remaining = max(0.0, deadline - time.monotonic())
            deadline_limited = remaining <= self._request_timeout
            try:
                events = self.list_turn_events(
                    session_id=session_id,
                    turn_id=turn_id,
                    after=cursor,
                    limit=2_000,
                    request_timeout=max(0.1, min(self._request_timeout, remaining)),
                )
            except GugoSdkError as error:
                if error.code == "GUGO_SDK_REQUEST_TIMEOUT" and deadline_limited:
                    break
                raise
            for event in events:
                cursor = _advance_event_cursor(event, cursor)
                if on_event:
                    on_event(event)
                if event.get("type") in _TERMINAL_EVENTS:
                    return event
            remaining = max(0.0, deadline - time.monotonic())
            if cancel_event is not None:
                if cancel_event.wait(min(interval / 1_000, remaining)):
                    _aborted(cancel_event)
            else:
                time.sleep(min(interval / 1_000, remaining))
        raise _sdk_error(
            "GUGO_SDK_TIMEOUT",
            f"Turn did not reach a terminal event within {timeout} ms",
        )

    def stream_turn_events(
        self,
        *,
        session_id: str,
        turn_id: str,
        after: int = -1,
        on_event: Callable[[Mapping[str, Any]], Any] | None = None,
        on_activity: Callable[[Mapping[str, Any]], Any] | None = None,
        cancel_event: threading.Event | None = None,
        request_timeout: float | None = None,
    ) -> Mapping[str, Any]:
        cursor = _safe_integer(after, "after", minimum=-1)
        request = Request(
            self._url(
                "/api/turns/stream",
                {
                    "sessionId": _required_id(session_id, "session_id"),
                    "turnId": _required_id(turn_id, "turn_id"),
                    "after": cursor,
                    "turnEventVersion": GUGO_SDK_CONTRACT_VERSION,
                },
            ),
            headers=self._headers(accept="text/event-stream"),
        )
        timeout = (
            _bounded_request_timeout(request_timeout)
            if request_timeout is not None
            else self._request_timeout
        )
        with self._open(request, timeout=timeout) as response:
            frame_lines: list[str] = []
            frame_bytes = 0
            while True:
                _aborted(cancel_event)
                raw_line = response.readline(_MAX_SSE_FRAME_BYTES + 1)
                if len(raw_line) > _MAX_SSE_FRAME_BYTES:
                    raise _sdk_error(
                        "GUGO_SDK_RESPONSE_INVALID",
                        "Turn stream frame buffer exceeded 8 MiB",
                    )
                if not raw_line:
                    break
                frame_bytes += len(raw_line)
                if frame_bytes > _MAX_SSE_FRAME_BYTES:
                    raise _sdk_error(
                        "GUGO_SDK_RESPONSE_INVALID",
                        "Turn stream frame buffer exceeded 8 MiB",
                    )
                try:
                    line = raw_line.decode("utf-8").rstrip("\r\n")
                except UnicodeDecodeError as error:
                    raise _sdk_error(
                        "GUGO_SDK_RESPONSE_INVALID", "Turn stream is not UTF-8"
                    ) from error
                if line:
                    frame_lines.append(line)
                    continue
                frame = parse_sse_frame(frame_lines)
                frame_lines = []
                frame_bytes = 0
                if frame is None or frame[0] == "ready":
                    continue
                event_type, data = frame
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError as error:
                    raise _sdk_error(
                        "GUGO_SDK_RESPONSE_INVALID",
                        "Turn stream returned invalid JSON",
                    ) from error
                if event_type == "error":
                    raise _error_payload(payload, int(getattr(response, "status", 500)))
                if event_type == "turn_activity":
                    if not isinstance(payload, Mapping):
                        raise _sdk_error(
                            "GUGO_SDK_RESPONSE_INVALID",
                            "Turn activity must be an object",
                        )
                    if on_activity:
                        on_activity(payload)
                    continue
                if event_type != "turn_event":
                    continue
                if (
                    not isinstance(payload, Mapping)
                    or payload.get("v") != GUGO_SDK_CONTRACT_VERSION
                    or payload.get("type") != "turn.event"
                    or not isinstance(payload.get("event"), Mapping)
                ):
                    raise _sdk_error(
                        "GUGO_SDK_RESPONSE_INVALID",
                        "Turn stream returned an invalid event envelope",
                    )
                event = payload["event"]
                cursor = _advance_event_cursor(event, cursor)
                if on_event:
                    on_event(event)
                if event.get("type") in _TERMINAL_EVENTS:
                    return event
        raise _sdk_error(
            "GUGO_SDK_STREAM_TRUNCATED",
            "Turn stream ended before a terminal event",
        )

    def cancel_turn(
        self,
        *,
        session_id: str,
        turn_id: str,
    ) -> Any:
        body = self._request(
            f"/api/turns/{quote(_required_id(turn_id, 'turn_id'), safe='')}/cancel",
            method="POST",
            body={"sessionId": _required_id(session_id, "session_id")},
        )
        return body.get("turn")

    def resume_turn(
        self,
        *,
        session_id: str,
        turn_id: str,
        resolution: Any = None,
        retry_failed: bool = False,
        retry_recovery: bool = False,
    ) -> Any:
        body = self._request(
            f"/api/turns/{quote(_required_id(turn_id, 'turn_id'), safe='')}/resume",
            method="POST",
            body={
                "sessionId": _required_id(session_id, "session_id"),
                "resolution": resolution,
                "retryFailed": retry_failed is True,
                "retryRecovery": retry_recovery is True,
            },
        )
        return body.get("turn")

    def steer_turn(
        self,
        *,
        session_id: str,
        turn_id: str,
        content: str,
        client_request_id: str,
    ) -> Any:
        if not isinstance(content, str) or not content.strip():
            raise _sdk_error(
                "GUGO_SDK_INPUT_INVALID", "content must be non-empty"
            )
        body = self._request(
            f"/api/turns/{quote(_required_id(turn_id, 'turn_id'), safe='')}/steer",
            method="POST",
            body={
                "sessionId": _required_id(session_id, "session_id"),
                "content": content,
                "clientRequestId": _required_id(
                    client_request_id, "client_request_id"
                ),
            },
        )
        return body.get("steering")


__all__ = [
    "GUGO_SDK_CONTRACT_VERSION",
    "GUGO_TURN_TERMINAL_EVENTS",
    "GugoClient",
    "GugoSdkError",
]
