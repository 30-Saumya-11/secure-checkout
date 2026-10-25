"""One error type for expected failures, so handlers can raise it and clients always get {"detail": ..., "code": ...}."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, detail: str, code: str | None = None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code

    def body(self) -> dict:
        out: dict = {"detail": self.detail}
        if self.code:
            out["code"] = self.code
        return out
