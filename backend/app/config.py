"""Settings from environment variables. Secrets are never hard-coded; see ../.env.example."""

from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field

log = logging.getLogger("store.config")


def _db_url(raw: str) -> str:
    # Render and Heroku hand out postgres://...; SQLAlchemy needs the driver named explicitly
    for prefix in ("postgres://", "postgresql://"):
        if raw.startswith(prefix):
            return "postgresql+psycopg://" + raw[len(prefix):]
    return raw


def _secret(name: str) -> str:
    value = os.environ.get(name)
    if value:
        return value
    # fine for local development; tokens and fingerprints change on every restart, so production must set it
    log.warning("%s is not set: using a random value for this process only", name)
    return secrets.token_hex(32)


def _flag(name: str, default: str = "false") -> bool:
    return os.environ.get(name, default).lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: _db_url(os.environ.get("DATABASE_URL", "postgresql+psycopg://postgres@127.0.0.1:5432/store")))
    jwt_secret: str = field(default_factory=lambda: _secret("JWT_SECRET"))
    # key for card fingerprints (HMAC of the card number): lets the fraud rule recognise the same card without storing it
    card_fingerprint_key: str = field(default_factory=lambda: _secret("CARD_FINGERPRINT_KEY"))
    jwt_minutes: int = int(os.environ.get("JWT_MINUTES", "480"))
    cors_origins: tuple[str, ...] = tuple(o for o in os.environ.get("CORS_ORIGINS", "http://localhost:5181,http://127.0.0.1:5181").split(",") if o)
    # demo tools: the "simulate a lost response" header and the built-in webhook receiver. Off in production.
    demo_tools: bool = _flag("DEMO_TOOLS")
    # background webhook delivery loop (tests call the dispatcher directly instead)
    webhook_dispatch: bool = _flag("WEBHOOK_DISPATCH", "true")
    webhook_interval_s: float = float(os.environ.get("WEBHOOK_INTERVAL_S", "2"))
    # fraud rule: this many declines for the same card within the window blocks further attempts
    velocity_max_declines: int = int(os.environ.get("VELOCITY_MAX_DECLINES", "3"))
    velocity_window_min: int = int(os.environ.get("VELOCITY_WINDOW_MIN", "10"))


settings = Settings()
