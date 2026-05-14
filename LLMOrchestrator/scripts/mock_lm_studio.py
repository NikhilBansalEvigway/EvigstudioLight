#!/usr/bin/env python3
"""Mock LM Studio OpenAI-compatible server (stdlib only).

Use this to load-test LLMOrchestrator queue/DB/Redis at high RPS without GPU.

Implements:
- GET  /api/v1/models
- POST /v1/chat/completions (JSON)
- POST /v1/chat/completions (SSE when stream=true)

No third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _now_ts() -> int:
    return int(time.time())


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    try:
        parsed = json.loads(raw.decode("utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _write_json(handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _fake_usage(payload: dict[str, Any], out_tokens: int) -> dict[str, int]:
    messages = payload.get("messages") or []
    prompt_chars = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        prompt_chars += len(str(m.get("content") or ""))
    prompt_tokens = max(1, prompt_chars // 4)
    completion_tokens = max(1, int(out_tokens))
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
    }


def _assistant_text(payload: dict[str, Any]) -> str:
    msgs = payload.get("messages") or []
    last_user = ""
    for m in reversed(msgs):
        if isinstance(m, dict) and m.get("role") == "user":
            last_user = str(m.get("content") or "")
            break
    last_user = last_user.strip().replace("\n", " ")
    if len(last_user) > 140:
        last_user = last_user[:140] + "..."
    return f"(mock) ok: {last_user}" if last_user else "(mock) ok"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep output quiet by default.
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/api/v1/models":
            _write_json(
                self,
                HTTPStatus.OK,
                {
                    "models": [
                        {
                            "id": "mock-model",
                            "key": "mock-model",
                            "loaded_instances": [{"device": "cpu"}],
                            "size_bytes": 123,
                        }
                    ]
                },
            )
            return

        _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/chat/completions":
            _write_json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        payload = _read_json(self)
        stream = bool(payload.get("stream"))
        model = str(payload.get("model") or "mock-model")
        max_tokens = payload.get("max_tokens")
        try:
            out_tokens = int(max_tokens) if max_tokens is not None else 32
        except Exception:
            out_tokens = 32

        content = _assistant_text(payload)
        usage = _fake_usage(payload, out_tokens=out_tokens)
        completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = _now_ts()

        if not stream:
            _write_json(
                self,
                HTTPStatus.OK,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "usage": usage,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
            return

        # SSE stream
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send_line(line: str) -> None:
            self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        # 2 chunks + final usage chunk + DONE
        parts = [content[: max(1, len(content) // 2)], content[max(1, len(content) // 2) :]]
        for part in parts:
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": {"content": part}, "finish_reason": None}],
            }
            send_line(f"data: {json.dumps(chunk, ensure_ascii=True)}\n")

        final = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "usage": usage,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        send_line(f"data: {json.dumps(final, ensure_ascii=True)}\n")
        send_line("data: [DONE]\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1234)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"mock lm studio running on http://{args.host}:{args.port}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
