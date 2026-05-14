from fastapi import APIRouter

from app.schemas.models import ModelCard, ModelListResponse
from app.services.model_registry import ModelRegistryService

router = APIRouter(prefix="/v1", tags=["models"])


@router.get("/models", response_model=ModelListResponse)
async def list_models() -> ModelListResponse:
    service = ModelRegistryService()
    models = await service.list_models(sync_remote=True)
    return ModelListResponse(
        data=[
            ModelCard(
                id=model.name,
                alias=model.alias,
                backend_url=model.backend_url,
                timeout_seconds=model.timeout_seconds,
                concurrency_limit=model.concurrency_limit,
                queue_limit=model.queue_limit,
                is_enabled=model.is_enabled,
            )
            for model in models
        ]
    )
