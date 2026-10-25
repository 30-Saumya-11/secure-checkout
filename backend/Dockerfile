FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# run as a normal user, not root
RUN useradd --create-home store && chown -R store /app
USER store
EXPOSE 8101
# migrate, add demo data if SEED_DEMO=true (only once: seed.py skips a seeded database), then serve
CMD ["sh", "-c", "alembic upgrade head && if [ \"$SEED_DEMO\" = true ]; then python seed.py; fi && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8101}"]
