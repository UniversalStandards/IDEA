from __future__ import annotations

from typing import Any


class HubError(Exception):
    """Base SDK error."""

    def __init__(self, message: str, *, status_code: int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.details = details


class AuthError(HubError):
    """Authentication or authorization failure."""


class QuotaExceededError(HubError):
    """Request rejected due to quota limits."""


class RateLimitError(HubError):
    """Request rejected due to rate limits."""


class NotFoundError(HubError):
    """Requested resource was not found."""


_HTTP_STATUS_TO_ERROR: dict[int, type[HubError]] = {
    401: AuthError,
    403: AuthError,
    404: NotFoundError,
    429: RateLimitError,
}


def map_http_error(status_code: int, message: str, details: Any = None) -> HubError:
    if status_code == 402 or status_code == 409:
        return QuotaExceededError(message, status_code=status_code, details=details)
    error_cls = _HTTP_STATUS_TO_ERROR.get(status_code, HubError)
    return error_cls(message, status_code=status_code, details=details)
