from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field

class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]] | None = None  

class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[ChatMessage]
    stream: bool = False
    temperature: float | None = None
    max_tokens: int | None = Field(default=None, alias="max_tokens")
    metadata: dict[str, Any] | None = None

class ChatCompletionChoiceMessage(BaseModel):
    model_config = ConfigDict(extra="allow")
    role: str
    content: str | None
    reasoning: str | None = None
    tool_calls: list[Any] | None = None

class ChatCompletionChoice(BaseModel):
    model_config = ConfigDict(extra="allow")
    index: int
    message: ChatCompletionChoiceMessage
    finish_reason: str | None = None
    logprobs: Any | None = None

class ChatCompletionUsage(BaseModel):
    model_config = ConfigDict(extra="allow")
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

class ChatCompletionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatCompletionChoice]
    usage: ChatCompletionUsage | None = None
