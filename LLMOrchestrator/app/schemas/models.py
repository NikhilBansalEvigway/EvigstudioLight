from pydantic import BaseModel


class ModelCard(BaseModel):
    id: str
    object: str = "model"
    owned_by: str = "llm-orchestrator"
    alias: str | None = None
    backend_url: str
    timeout_seconds: int
    concurrency_limit: int
    queue_limit: int
    is_enabled: bool


class ModelListResponse(BaseModel):
    object: str = "list"
    data: list[ModelCard]
