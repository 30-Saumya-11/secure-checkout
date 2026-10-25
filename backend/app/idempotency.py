"""Idempotency keys, stored in the SAME transaction as the action they protect.

    1. INSERT the key (user, key) ... ON CONFLICT DO NOTHING.
       If another request with the same key is still running, Postgres makes this INSERT wait for it to finish.
    2. Inserted  -> run the action, save its response on the key row, COMMIT once (action + key together).
       Not inserted -> the key was used before: same request body -> replay the saved response;
                       different body -> 409, a client bug must not be "answered" with someone else's result.

Because the key and the action commit together, there is no window in which the action happened but the key was
not recorded (or the other way round). An unexpected crash rolls back both, so the client can simply retry.
Expected business errors (e.g. "refund too large") are saved and replayed like successes, as payment APIs do.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .errors import ApiError
from .models import IdempotencyKey


def request_hash(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()


def run_once(session: Session, *, user_id: int, key: str | None, scope: str, body: dict,
             action: Callable[[], tuple[int, dict]]) -> tuple[int, dict, bool]:
    """Returns (status code, response body, replayed?)."""
    if not key or len(key) > 100:
        raise ApiError(400, "An Idempotency-Key header (1-100 characters) is required.", "idempotency_key_required")
    digest = request_hash(body)
    inserted = session.execute(
        insert(IdempotencyKey)
        .values(user_id=user_id, key=key, scope=scope, request_hash=digest)
        .on_conflict_do_nothing(constraint="uq_idempotency_user_key")
        .returning(IdempotencyKey.id)
    ).scalar()

    if inserted is None:
        row = session.execute(select(IdempotencyKey).where(IdempotencyKey.user_id == user_id, IdempotencyKey.key == key)).scalar_one()
        session.rollback()
        if row.scope != scope or row.request_hash != digest:
            raise ApiError(409, "This Idempotency-Key was already used for a different request.", "idempotency_conflict")
        return row.status_code or 200, row.response or {}, True

    try:
        with session.begin_nested():  # savepoint: a business error undoes the action's changes but keeps the key row
            status, response = action()
    except ApiError as e:
        status, response = e.status, e.body()
    session.execute(update(IdempotencyKey).where(IdempotencyKey.id == inserted).values(status_code=status, response=response))
    session.commit()
    return status, response, False
