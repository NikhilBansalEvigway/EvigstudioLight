from __future__ import annotations

import json
import os
import re
import uuid
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx

from app.core.settings import get_settings


def _running_in_docker() -> bool:
    return os.path.exists("/.dockerenv")


def _remap_loopback_lm_studio_base(url: str) -> str:
    """Map localhost/127.0.0.1 to the Docker host so containers reach LM Studio on the machine.

    User settings often use http://localhost:1234; from inside a container that targets the
    container itself, not the host. Optional env overrides:
    - LM_STUDIO_DISABLE_LOOPBACK_REMAP=1 to skip
    - LM_STUDIO_DOCKER_GATEWAY=host (default host.docker.internal)
    """
    stripped = (url or "").strip()
    if not stripped or not _running_in_docker():
        return stripped
    flag = os.environ.get("LLM_STUDIO_DISABLE_LOOPBACK_REMAP", "").lower()
    if flag in ("1", "true", "yes"):
        return stripped
    parsed = urlparse(stripped)
    host = (parsed.hostname or "").lower()
    if host not in ("localhost", "127.0.0.1", "::1"):
        return stripped
    port = parsed.port if parsed.port is not None else 1234
    gateway = os.environ.get("LM_STUDIO_DOCKER_GATEWAY", "host.docker.internal")
    new_netloc = f"{gateway}:{port}"
    return urlunparse(parsed._replace(netloc=new_netloc))


def _parse_gemma_value(s: str) -> Any:
    """Parse a single Gemma-encoded value into a Python object."""
    s = s.strip()

    # Standard JSON string (Gemma 4 XML tool_call payloads often use "..." values)
    if len(s) >= 2 and s[0] == '"' and s.endswith('"'):
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            pass

    # Quoted string: <|"|>...<|"|>
    if s.startswith('<|"|>') and s.endswith('<|"|>'):
        return s[5:-5]

    # Boolean
    if s == 'true':
        return True
    if s == 'false':
        return False

    # Number
    try:
        if '.' in s:
            return float(s)
        return int(s)
    except ValueError:
        pass

    # Array: [...]
    if s.startswith('[') and s.endswith(']'):
        return _parse_gemma_array(s[1:-1])

    # Object: {...}
    if s.startswith('{') and s.endswith('}'):
        return _parse_gemma_object(s[1:-1])

    # Fallback: return as string
    return s


def _split_gemma_args(s: str) -> list[str]:
    """Split a comma-delimited Gemma argument string respecting nesting."""
    parts = []
    depth = 0
    current: list[str] = []
    i = 0
    while i < len(s):
        # Track <|"|> quoted strings so commas inside don't split
        if s[i:i + 5] == '<|"|>':
            end = s.find('<|"|>', i + 5)
            if end != -1:
                current.append(s[i:end + 5])
                i = end + 5
                continue
        if s[i] == '"':
            j = i + 1
            while j < len(s):
                if s[j] == '\\':
                    j += 2
                    continue
                if s[j] == '"':
                    current.append(s[i : j + 1])
                    i = j + 1
                    break
                j += 1
            else:
                current.append(s[i])
                i += 1
            continue
        c = s[i]
        if c in ('{', '['):
            depth += 1
        elif c in ('}', ']'):
            depth -= 1
        if c == ',' and depth == 0:
            parts.append(''.join(current).strip())
            current = []
        else:
            current.append(c)
        i += 1
    if current:
        parts.append(''.join(current).strip())
    return [p for p in parts if p]


def _parse_gemma_object(s: str) -> dict:
    """Parse key:value pairs from a Gemma-encoded object body."""
    result = {}
    parts = _split_gemma_args(s)
    for part in parts:
        colon_idx = None
        depth = 0
        i = 0
        while i < len(part):
            if part[i:i + 5] == '<|"|>':
                end = part.find('<|"|>', i + 5)
                if end != -1:
                    i = end + 5
                    continue
            if part[i] == '"':
                j = i + 1
                while j < len(part):
                    if part[j] == '\\':
                        j += 2
                        continue
                    if part[j] == '"':
                        i = j + 1
                        break
                    j += 1
                else:
                    i += 1
                continue
            if part[i] in ('{', '['):
                depth += 1
            elif part[i] in ('}', ']'):
                depth -= 1
            if part[i] == ':' and depth == 0:
                colon_idx = i
                break
            i += 1
        if colon_idx is not None:
            key = part[:colon_idx].strip()
            value = part[colon_idx + 1:].strip()
            result[key] = _parse_gemma_value(value)
    return result


def _parse_gemma_array(s: str) -> list:
    """Parse items from a Gemma-encoded array body."""
    parts = _split_gemma_args(s)
    return [_parse_gemma_value(p) for p in parts]


def _parse_gemma_tool_call(tool_call_str: str) -> dict | None:
    """
    Parse a Gemma tool call string like:
      call:terminal{command:<|"|>ls -R<|"|>,security_risk:<|"|>LOW<|"|>}
    into OpenAI tool_call format.
    """
    match = re.match(r'call:([\w.-]+)\{(.*)\}$', tool_call_str.strip(), re.DOTALL)
    if not match:
        return None

    name = match.group(1)
    args_str = match.group(2)
    arguments = _parse_tool_call_arguments(args_str)

    return {
        'id': f'call_{uuid.uuid4().hex[:24]}',
        'type': 'function',
        'function': {
            'name': name,
            'arguments': json.dumps(arguments),
        },
    }


def _quote_unquoted_js_keys(body: str) -> str:
    """Turn `key:` into quoted keys so json.loads accepts JS-style literals."""
    return re.sub(
        r'([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:',
        r'\1"\2":',
        body,
    )


def _parse_tool_call_arguments(args_str: str) -> dict:
    """
    Parse tool arguments: strict JSON, JS-like literals (unquoted keys), or
    Gemma <|"|> string tokens.
    """
    raw = args_str.strip()
    if not raw:
        return {}

    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    try:
        fixed = _quote_unquoted_js_keys(raw)
        parsed = json.loads(fixed)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    if raw.startswith('{') and raw.endswith('}'):
        return _parse_gemma_object(raw[1:-1])
    return _parse_gemma_object(raw)


def _strip_thought_channels(content: str) -> str:
    content = re.sub(
        r'<\|channel>thought.*?<channel\|>',
        '',
        content,
        flags=re.DOTALL,
    )
    content = re.sub(
        r'<redacted_reasoning>.*?</redacted_reasoning>',
        '',
        content,
        flags=re.DOTALL | re.IGNORECASE,
    )
    # Qwen3-style: <think>...</think>
    content = re.sub(
        r'<redacted_think>'
        r'.*?</think>',
        '',
        content,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return content.strip()


def _split_call_blob(blob: str) -> list[str]:
    """Split text that may contain multiple `call:name{...}` tool invocations."""
    blob = blob.strip()
    if not blob:
        return []

    out: list[str] = []
    i = 0
    while i < len(blob):
        m = re.match(r'call:[\w.-]+\{', blob[i:])
        if not m:
            break
        start = i + m.start()
        open_brace = i + m.end() - 1
        depth = 0
        j = open_brace
        while j < len(blob):
            if blob[j] == '{':
                depth += 1
            elif blob[j] == '}':
                depth -= 1
                if depth == 0:
                    out.append(blob[start : j + 1])
                    i = j + 1
                    while i < len(blob) and blob[i] in ', \n\r\t':
                        i += 1
                    break
            j += 1
        else:
            break
    return out


def _consume_balanced_braces(text: str, open_idx: int) -> int | None:
    """Return index after closing `}` for `{` at open_idx, or None if unbalanced."""
    if open_idx >= len(text) or text[open_idx] != '{':
        return None
    depth = 0
    for j in range(open_idx, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return j + 1
    return None


def _extend_span_strip_wrappers(text: str, start: int, end: int) -> tuple[int, int]:
    """Widen removal span to drop common Gemma/LM Studio tool-call wrappers."""
    prefixes = ('<|tool_call>', '<|tool_call|>', '<tool_call>')
    suffixes = ('<tool_call|>', '<|tool_call|>', '</tool_call>')
    s, e = start, end
    scan = start
    while scan > 0 and text[scan - 1] in ' \t\n\r':
        scan -= 1
    for p in prefixes:
        lp = len(p)
        if scan >= lp and text[scan - lp : scan].lower() == p.lower():
            s = scan - lp
            break
    for suf in suffixes:
        ls = len(suf)
        if e + ls <= len(text) and text[e : e + ls].lower() == suf.lower():
            e += ls
            break
    return s, e


def _extract_call_blocks_by_brace_scan(text: str) -> tuple[str, list[str]]:
    """
    Find `call:tool_name{...}` spans by brace depth. Used when delimiter regexes
    do not match (alternate closings, tokenizer quirks).
    """
    raw_spans: list[tuple[int, int, str]] = []
    search_from = 0
    while search_from < len(text):
        m = re.search(r'call:[\w.-]+\{', text[search_from:])
        if not m:
            break
        abs_start = search_from + m.start()
        open_brace = search_from + m.end() - 1
        close_end = _consume_balanced_braces(text, open_brace)
        if close_end is None:
            break
        raw_spans.append((abs_start, close_end, text[abs_start:close_end]))
        search_from = close_end

    if not raw_spans:
        return text, []

    trim_spans: list[tuple[int, int, str]] = []
    for start, end, call_s in raw_spans:
        ts, te = _extend_span_strip_wrappers(text, start, end)
        trim_spans.append((ts, te, call_s))

    trim_spans.sort(key=lambda x: x[0])
    out_calls = [c for _, _, c in trim_spans]
    out_parts: list[str] = []
    cursor = 0
    for ts, te, _ in trim_spans:
        out_parts.append(text[cursor:ts])
        cursor = te
    out_parts.append(text[cursor:])
    return ''.join(out_parts).strip(), out_calls


def _extract_embedded_tool_call_strings(content: str) -> tuple[str, list[str]]:
    """
    Remove tool-call markup and return inner `call:tool{...}` strings.

    Supports:
      <|tool_call>call:name{...}<tool_call|>
      <|tool_call>call:name{...}<|tool_call|>
      <tool_call>call:name{...}</tool_call>
      <tool_calls>...</tool_calls>
    """
    payloads: list[str] = []

    def _pull(pattern: re.Pattern[str], text: str) -> str:
        for block in pattern.findall(text):
            inner = (block or '').strip()
            if inner:
                payloads.append(inner)
        return pattern.sub('', text)

    content = _pull(
        re.compile(
            r'<tool_calls>\s*(.*?)\s*</tool_calls>',
            re.DOTALL | re.IGNORECASE,
        ),
        content,
    )
    content = _pull(
        re.compile(
            r'<tool_call>\s*(.*?)\s*</tool_call>',
            re.DOTALL | re.IGNORECASE,
        ),
        content,
    )
    # Gemma / LM Studio pipe variants (closing may be <tool_call|> or <|tool_call|>)
    content = _pull(
        re.compile(
            r'<\|tool_call>\s*(.*?)\s*<tool_call\|>',
            re.DOTALL,
        ),
        content,
    )
    content = _pull(
        re.compile(
            r'<\|tool_call>\s*(.*?)\s*<\|tool_call\|>',
            re.DOTALL,
        ),
        content,
    )

    expanded: list[str] = []
    for blob in payloads:
        expanded.extend(_split_call_blob(blob))

    if expanded:
        return content.strip(), expanded

    # Fallback: raw `call:tool{...}` without recognized wrappers (or unknown delimiters)
    return _extract_call_blocks_by_brace_scan(content)


def _transform_gemma_response(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Normalize tool calls embedded in assistant `content` into OpenAI `tool_calls`.

    Handles pipe-style Gemma tokens and plain XML `<tool_call>...</tool_call>` as
    emitted by several LM Studio models (including Gemma 4 26B in the web UI).
    """
    choices = payload.get('choices')
    if not choices:
        return payload

    for choice in choices:
        message = choice.get('message', {})
        content = message.get('content') or ''

        if not isinstance(content, str):
            continue

        lowered = content.lower()
        looks_like_embedded_tools = (
            '<tool_call' in lowered
            or '<|tool_call>' in content
            or '<tool_calls' in lowered
            or '<|channel>thought' in content
            or '<think>' in lowered
            or ('<redacted_' + 'think>') in lowered
            or '<redacted_reasoning>' in lowered
            or re.search(r'call:[\w.-]+\{', content) is not None
        )
        if not looks_like_embedded_tools:
            continue

        content = _strip_thought_channels(content)
        content, raw_tool_calls = _extract_embedded_tool_call_strings(content)

        parsed_tool_calls: list[dict] = []
        for raw in raw_tool_calls:
            one = _parse_gemma_tool_call(raw)
            if one:
                parsed_tool_calls.append(one)

        message['content'] = content if content else None
        if parsed_tool_calls:
            message['tool_calls'] = parsed_tool_calls
            choice['finish_reason'] = 'tool_calls'
        elif not message.get('tool_calls'):
            message['tool_calls'] = []

    return payload


class LMStudioClient:
    def __init__(self) -> None:
        self.settings = get_settings()

    def _resolve_base_url(self, lm_studio_base_url: str | None = None) -> str:
        override = (lm_studio_base_url or "").strip()
        base = override or self.settings.lm_studio_base_url
        return _remap_loopback_lm_studio_base(base.rstrip("/"))

    async def chat_completion(
        self,
        payload: dict[str, Any],
        timeout_seconds: int,
        lm_studio_base_url: str | None = None,
    ) -> dict[str, Any]:
        base_url = self._resolve_base_url(lm_studio_base_url)
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                f'{base_url}/v1/chat/completions',
                json=payload,
            )
            response.raise_for_status()
            result = response.json()
            return _transform_gemma_response(result)

    async def chat_completion_stream(
        self,
        payload: dict[str, Any],
        timeout_seconds: int,
        lm_studio_base_url: str | None = None,
    ):
        base_url = self._resolve_base_url(lm_studio_base_url)
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            async with client.stream(
                "POST",
                f"{base_url}/v1/chat/completions",
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    yield f"{line}\n\n"
