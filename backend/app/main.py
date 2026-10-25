"""Campus Store Payments API.   uvicorn app.main:app --port 8101   ->  docs at /docs"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import observability, webhooks
from .config import settings
from .db import SessionLocal
from .errors import ApiError
from .routes import dev, merchant, store

logging.basicConfig(level=logging.INFO, format="%(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    stop = webhooks.start_dispatcher(SessionLocal, settings.webhook_interval_s) if settings.webhook_dispatch else None
    yield
    if stop:
        stop.set()


app = FastAPI(title="Campus Store Payments API", version="2.0.0", lifespan=lifespan,
              description="Store, payments with idempotency keys, 3-D Secure, refunds and signed webhooks. "
                          "Demo gateway: no real card network is contacted.")
observability.install(app)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["*"],
                   allow_headers=["*"], expose_headers=["X-Request-ID", "Idempotent-Replayed"])


@app.exception_handler(ApiError)
async def api_error(_: Request, e: ApiError) -> JSONResponse:
    return JSONResponse(e.body(), status_code=e.status)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "demo_tools": settings.demo_tools}


app.include_router(store.router)
app.include_router(merchant.router)
if settings.demo_tools:
    app.include_router(dev.router)
