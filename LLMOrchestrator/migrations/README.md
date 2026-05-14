# Migrations

This directory contains Alembic migration assets for LLMOrchestrator.

Create the first migration after dependencies are installed:

```bash
alembic revision --autogenerate -m "initial schema"
alembic upgrade head
```
