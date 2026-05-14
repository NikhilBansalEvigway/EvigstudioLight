FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install poetry && poetry config virtualenvs.create false && poetry install --no-root
ENV PYTHONPATH=/app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3013"]
