"""Demo tools (only mounted when DEMO_TOOLS=true): a webhook receiver that checks signatures, so the delivery log
shows real signed requests end to end without the merchant running a second server."""

from __future__ import annotations

from collections import deque

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import webhooks
from ..db import get_session
from ..models import WebhookEndpoint

router = APIRouter(prefix="/api/dev", tags=["demo tools"])
RECEIVED: deque = deque(maxlen=50)


@router.post("/webhook-receiver")
async def receiver(request: Request, session: Session = Depends(get_session)):
    body = await request.body()
    header = request.headers.get(webhooks.HEADER)
    secrets_ = [ep.secret for ep in session.execute(select(WebhookEndpoint)).scalars()]
    ok = any(webhooks.verify(s, body, header) for s in secrets_)
    RECEIVED.append({"event_id": request.headers.get("Campus-Event-Id"), "signature_valid": ok})
    if not ok:
        return JSONResponse({"detail": "bad signature"}, status_code=400)
    return {"received": True}
