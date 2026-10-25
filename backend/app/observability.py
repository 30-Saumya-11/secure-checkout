"""Request IDs, one JSON log line per request, and in-process metrics per route template."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import defaultdict, deque

from fastapi import FastAPI, Request

log = logging.getLogger("store.access")
_LOCK = threading.Lock()
_LAT: dict[str, deque] = defaultdict(lambda: deque(maxlen=1000))
_CODES: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))


def install(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_id(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        t0 = time.perf_counter()
        response = await call_next(request)
        ms = (time.perf_counter() - t0) * 1000
        route = request.scope.get("route")
        # group by template ("/api/payments/{payment_id}"), not by the concrete URL, so ids do not explode the metrics
        name = f"{request.method} {getattr(route, 'path', request.url.path)}"
        with _LOCK:
            _LAT[name].append(ms)
            _CODES[name][response.status_code] += 1
        response.headers["X-Request-ID"] = rid
        log.info(json.dumps({"rid": rid, "route": name, "status": response.status_code, "ms": round(ms, 1)}))
        return response


def _p(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    return round(s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))], 1)


def snapshot() -> dict:
    with _LOCK:
        return {
            name: {"requests": sum(_CODES[name].values()), "status": dict(_CODES[name]),
                   "p50_ms": _p(list(_LAT[name]), 0.5), "p95_ms": _p(list(_LAT[name]), 0.95)}
            for name in sorted(_CODES)
        }
