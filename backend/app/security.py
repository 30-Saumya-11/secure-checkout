"""Passwords (bcrypt), sessions (JWT) and role checks."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, Header
from sqlalchemy.orm import Session

from .config import settings
from .db import get_session
from .errors import ApiError
from .models import User


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def issue_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    claims = {"sub": str(user.id), "role": user.role, "iat": now, "exp": now + timedelta(minutes=settings.jwt_minutes)}
    return jwt.encode(claims, settings.jwt_secret, algorithm="HS256")


def current_user(authorization: str | None = Header(default=None), session: Session = Depends(get_session)) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise ApiError(401, "Please sign in.")
    try:
        # the algorithm is pinned: a token claiming "alg: none" is rejected
        claims = jwt.decode(authorization[7:], settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise ApiError(401, "Your session has expired. Please sign in again.") from None
    user = session.get(User, int(claims["sub"]))
    if user is None:
        raise ApiError(401, "Please sign in.")
    return user


def merchant(user: User = Depends(current_user)) -> User:
    if user.role != "merchant":
        raise ApiError(403, "Only the merchant can do this.")
    return user


def actor(user: User) -> str:
    return f"{user.role}:{user.id}"
