#!/usr/bin/env python3
"""LLMOrchestrator scenario load tester with live queue/db visualization.

Runs realistic traffic patterns (steady, bursty, mixed sizes, ramp, streaming mix,
multi-turn) against `POST /v1/chat/completions` and optionally polls orchestrator
metrics + admin DB-backed endpoints to visualize queue pressure live.

Designed to be dependency-light (stdlib + httpx).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import statistics
import sys
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx


CHAT_PATH_DEFAULT = "/v1/chat/completions"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pct(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    idx = (len(ordered) - 1) * percentile
    lo = int(math.floor(idx))
    hi = min(lo + 1, len(ordered) - 1)
    frac = idx - lo
    return ordered[lo] + (ordered[hi] - ordered[lo]) * frac


def _ansi_clear() -> str:
    return "\x1b[2J\x1b[H"


def _sparkline(points: list[float], *, width: int = 30) -> str:
    """Tiny fixed-width sparkline without extra deps."""
    if not points:
        return "".ljust(width)
    if len(points) <= width:
        sample = points
    else:
        step = len(points) / width
        sample = [points[int(i * step)] for i in range(width)]
    lo = min(sample)
    hi = max(sample)
    if hi <= lo:
        return ("_" * len(sample)).ljust(width)
    chars = " .:-=+*#%@"
    out = []
    for v in sample:
        t = (v - lo) / (hi - lo)
        out.append(chars[min(int(t * (len(chars) - 1)), len(chars) - 1)])
    return "".join(out).ljust(width)


def _parse_prom_metrics(text: str) -> dict[str, Any]:
    """Parse /metrics (Prometheus text) into a small dict."""
    active: dict[str, int] = {}
    waiting: dict[str, int] = {}
    workers_active: int | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("llm_orchestrator_active_requests"):
            # llm_orchestrator_active_requests{model="..."} 1
            try:
                left, val_s = line.rsplit(" ", 1)
                val = int(float(val_s))
                model = left.split("model=\"", 1)[1].split('"', 1)[0]
                active[model] = val
            except Exception:
                continue
        elif line.startswith("llm_orchestrator_waiting_requests"):
            try:
                left, val_s = line.rsplit(" ", 1)
                val = int(float(val_s))
                model = left.split("model=\"", 1)[1].split('"', 1)[0]
                waiting[model] = val
            except Exception:
                continue
        elif line.startswith("llm_orchestrator_workers_active"):
            try:
                _, val_s = line.rsplit(" ", 1)
                workers_active = int(float(val_s))
            except Exception:
                continue
    return {
        "active_by_model": active,
        "waiting_by_model": waiting,
        "workers_active": workers_active,
    }


@dataclass
class Segment:
    duration_s: float
    rps: float


@dataclass
class Scenario:
    name: str
    segments: list[Segment]
    mix: str
    stream_ratio: float
    use_queue: bool
    max_tokens: int | None
    cancel_ratio: float
    cancel_after_s: float
    db_probe: bool
    db_probe_kind: str


@dataclass
class Counters:
    sent: int = 0
    ok: int = 0
    failed: int = 0
    cancelled: int = 0
    in_flight: int = 0
    http_429: int = 0
    http_5xx: int = 0
    other_http: int = 0


class SlidingRates:
    def __init__(self, *, window_s: float = 10.0) -> None:
        self.window_s = window_s
        self.sent_ts: deque[float] = deque()
        self.ok_ts: deque[float] = deque()
        self.fail_ts: deque[float] = deque()

    def _trim(self, q: deque[float], now: float) -> None:
        cutoff = now - self.window_s
        while q and q[0] < cutoff:
            q.popleft()

    def mark_sent(self, now: float) -> None:
        self.sent_ts.append(now)
        self._trim(self.sent_ts, now)

    def mark_ok(self, now: float) -> None:
        self.ok_ts.append(now)
        self._trim(self.ok_ts, now)

    def mark_fail(self, now: float) -> None:
        self.fail_ts.append(now)
        self._trim(self.fail_ts, now)

    def snapshot(self, now: float) -> dict[str, float]:
        self._trim(self.sent_ts, now)
        self._trim(self.ok_ts, now)
        self._trim(self.fail_ts, now)
        return {
            "sent_rps": len(self.sent_ts) / self.window_s,
            "ok_rps": len(self.ok_ts) / self.window_s,
            "fail_rps": len(self.fail_ts) / self.window_s,
        }


def _make_text(size: str) -> str:
    # Roughly controls prompt size without tokenizers.
    if size == "short":
        base = "Answer in 1-2 sentences. "
        return base + "What is the difference between a process and a thread?"
    if size == "medium":
        filler = " ".join(["context"] * 800)
        return (
            "Summarize the main points and provide 3 bullet recommendations.\n\n"
            + filler
        )
    if size == "long":
        filler = " ".join(["context"] * 4000)
        return (
            "You are given a long background. Extract key requirements and risks.\n\n"
            + filler
        )
    return "Hello"


def _pick_size(mix: str) -> str:
    if mix == "fixed_short":
        return "short"
    if mix == "fixed_medium":
        return "medium"
    if mix == "fixed_long":
        return "long"
    if mix == "mixed":
        # 70/25/5
        r = random.random()
        if r < 0.70:
            return "short"
        if r < 0.95:
            return "medium"
        return "long"
    if mix == "multi_turn":
        return "medium"
    return "short"


def _build_payload(
    *,
    model: str,
    mix: str,
    max_tokens: int | None,
    stream: bool,
    user_id: str | None,
    org_id: str | None,
    source_app: str,
    trace_id: str,
) -> dict[str, Any]:
    size = _pick_size(mix)
    if mix == "multi_turn":
        # Context grows: 6-10 turns.
        turns = random.randint(6, 10)
        msgs: list[dict[str, Any]] = [{"role": "system", "content": "You are concise."}]
        for i in range(turns - 1):
            msgs.append({"role": "user", "content": f"User turn {i}: {_make_text('short')}"})
            msgs.append({"role": "assistant", "content": "Ack."})
        msgs.append({"role": "user", "content": _make_text(size)})
        messages = msgs
    else:
        messages = [{"role": "user", "content": _make_text(size)}]

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "metadata": {
            "source_app": source_app,
            "user_id": user_id,
            "org_id": org_id,
            "trace_id": trace_id,
        },
    }
    if max_tokens is not None:
        payload["max_tokens"] = int(max_tokens)
    return payload


async def _read_sse_to_done(resp: httpx.Response) -> None:
    async for line in resp.aiter_lines():
        if not line:
            continue
        stripped = line.strip()
        if stripped == "data: [DONE]" or stripped.endswith("[DONE]"):
            return


async def _send_one(
    *,
    client: httpx.AsyncClient,
    url: str,
    scenario: Scenario,
    model: str,
    user_id: str | None,
    org_id: str | None,
    source_app: str,
    counters: Counters,
    rates: SlidingRates,
    latencies_ms: list[float],
    errors: deque[str],
    request_timeout_s: float,
) -> None:
    start = time.perf_counter()
    now = time.monotonic()
    rates.mark_sent(now)
    counters.sent += 1
    counters.in_flight += 1
    trace_id = f"lt-{int(start * 1e6)}-{random.randint(1000, 9999)}"
    stream = random.random() < scenario.stream_ratio

    payload = _build_payload(
        model=model,
        mix=scenario.mix,
        max_tokens=scenario.max_tokens,
        stream=stream,
        user_id=user_id,
        org_id=org_id,
        source_app=source_app,
        trace_id=trace_id,
    )

    headers = {
        "x-user-id": user_id or "",
        "x-org-id": org_id or "",
        "x-source-app": source_app,
        "x-trace-id": trace_id,
    }

    async def do_request() -> tuple[int, str]:
        if stream:
            async with client.stream(
                "POST",
                url,
                params={"use_queue": str(scenario.use_queue).lower()},
                json=payload,
                timeout=request_timeout_s,
                headers=headers,
            ) as resp:
                if resp.status_code == 200:
                    await _read_sse_to_done(resp)
                    return 200, ""
                # Drain a small excerpt for diagnostics.
                body = await resp.aread()
                return resp.status_code, body[:200].decode("utf-8", errors="replace")

        resp = await client.post(
            url,
            params={"use_queue": str(scenario.use_queue).lower()},
            json=payload,
            timeout=request_timeout_s,
            headers=headers,
        )
        try:
            text = resp.text
        except Exception:
            text = ""
        finally:
            await resp.aclose()
        return resp.status_code, text[:200]

    req_task = asyncio.create_task(do_request())

    if scenario.cancel_ratio > 0 and random.random() < scenario.cancel_ratio:
        await asyncio.sleep(max(0.0, scenario.cancel_after_s))
        if not req_task.done():
            req_task.cancel()
            counters.cancelled += 1
            counters.in_flight -= 1
            rates.mark_fail(time.monotonic())
            return

    try:
        status_code, body_excerpt = await req_task
        elapsed_ms = (time.perf_counter() - start) * 1000
        latencies_ms.append(elapsed_ms)

        if status_code == 200:
            counters.ok += 1
            rates.mark_ok(time.monotonic())
        else:
            counters.failed += 1
            rates.mark_fail(time.monotonic())
            if status_code == 429:
                counters.http_429 += 1
            elif 500 <= status_code < 600:
                counters.http_5xx += 1
            else:
                counters.other_http += 1
            if len(errors) < errors.maxlen:
                errors.append(f"HTTP {status_code}: {body_excerpt}")
    except asyncio.CancelledError:
        counters.cancelled += 1
        rates.mark_fail(time.monotonic())
        raise
    except Exception as exc:
        counters.failed += 1
        rates.mark_fail(time.monotonic())
        if len(errors) < errors.maxlen:
            errors.append(str(exc)[:200])
    finally:
        counters.in_flight -= 1


async def _poll_metrics_loop(
    *,
    client: httpx.AsyncClient,
    orch_url: str,
    interval_s: float,
    stop: asyncio.Event,
    out: list[dict[str, Any]],
) -> None:
    while not stop.is_set():
        try:
            resp = await client.get(f"{orch_url}/metrics", timeout=8.0)
            if resp.status_code == 200:
                parsed = _parse_prom_metrics(resp.text)
                out.append({"ts": _now_iso(), **parsed})
        except Exception:
            # Keep polling best-effort.
            pass
        await asyncio.sleep(interval_s)


async def _poll_db_loop(
    *,
    client: httpx.AsyncClient,
    orch_url: str,
    token: str,
    kind: str,
    interval_s: float,
    stop: asyncio.Event,
    out: list[dict[str, Any]],
) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    while not stop.is_set():
        start = time.perf_counter()
        ok = False
        status = 0
        try:
            if kind == "overview":
                resp = await client.get(f"{orch_url}/admin/overview", headers=headers, timeout=20.0)
            elif kind == "requests":
                resp = await client.get(
                    f"{orch_url}/admin/requests",
                    headers=headers,
                    params={"limit": 200, "offset": 0, "sort_by": "created_at", "sort_dir": "desc"},
                    timeout=20.0,
                )
            else:
                resp = await client.get(f"{orch_url}/ready", timeout=8.0)
            status = resp.status_code
            ok = resp.status_code == 200
        except Exception:
            ok = False
        elapsed_ms = (time.perf_counter() - start) * 1000
        out.append({"ts": _now_iso(), "kind": kind, "ok": ok, "status": status, "ms": elapsed_ms})
        await asyncio.sleep(interval_s)


async def _orch_login(orch_url: str, user: str, password: str) -> str:
    async with httpx.AsyncClient(timeout=12.0) as c:
        resp = await c.post(f"{orch_url}/admin/login", json={"username": user, "password": password})
    if resp.status_code != 200:
        return ""
    return str(resp.json().get("access_token") or "")


def _default_scenarios(*, rps: float, duration_s: float, use_queue: bool, max_tokens: int) -> list[Scenario]:
    return [
        Scenario(
            name="warmup",
            segments=[Segment(duration_s=60, rps=min(5.0, rps))],
            mix="fixed_short",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=False,
            db_probe_kind="requests",
        ),
        Scenario(
            name="steady_50rps_short",
            segments=[Segment(duration_s=duration_s, rps=rps)],
            mix="fixed_short",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=True,
            db_probe_kind="requests",
        ),
        Scenario(
            name="steady_50rps_mixed",
            segments=[Segment(duration_s=duration_s, rps=rps)],
            mix="mixed",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=True,
            db_probe_kind="overview",
        ),
        Scenario(
            name="bursty_avg_50rps",
            segments=[
                Segment(duration_s=10, rps=rps * 2),
                Segment(duration_s=10, rps=0),
            ]
            * max(int(duration_s // 20), 1),
            mix="mixed",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=True,
            db_probe_kind="requests",
        ),
        Scenario(
            name="ramp_to_50rps",
            segments=[
                Segment(duration_s=60, rps=min(10, rps)),
                Segment(duration_s=60, rps=min(20, rps)),
                Segment(duration_s=60, rps=min(30, rps)),
                Segment(duration_s=60, rps=min(40, rps)),
                Segment(duration_s=60, rps=rps),
            ],
            mix="fixed_short",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=False,
            db_probe_kind="requests",
        ),
        Scenario(
            name="streaming_mix",
            segments=[Segment(duration_s=duration_s, rps=rps)],
            mix="fixed_short",
            stream_ratio=0.6,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.02,
            cancel_after_s=1.0,
            db_probe=True,
            db_probe_kind="overview",
        ),
        Scenario(
            name="multi_turn_sessions",
            segments=[Segment(duration_s=duration_s, rps=rps)],
            mix="multi_turn",
            stream_ratio=0.0,
            use_queue=use_queue,
            max_tokens=max_tokens,
            cancel_ratio=0.0,
            cancel_after_s=0.0,
            db_probe=True,
            db_probe_kind="requests",
        ),
    ]


async def _run_scenario(
    *,
    orch_url: str,
    chat_path: str,
    scenario: Scenario,
    model: str,
    users: list[str] | None,
    orgs: list[str] | None,
    max_inflight: int,
    request_timeout_s: float,
    poll_interval_s: float,
    admin_user: str,
    admin_pass: str,
    enable_live: bool,
) -> dict[str, Any]:
    url = f"{orch_url}{chat_path}"
    counters = Counters()
    rates = SlidingRates(window_s=10.0)
    latencies_ms: list[float] = []
    errors: deque[str] = deque(maxlen=12)
    metrics_series: list[dict[str, Any]] = []
    db_series: list[dict[str, Any]] = []

    stop = asyncio.Event()
    start_wall = time.perf_counter()
    start_mono = time.monotonic()

    limits = httpx.Limits(max_connections=max(200, max_inflight), max_keepalive_connections=100)
    async with httpx.AsyncClient(limits=limits) as client:
        poll_tasks: list[asyncio.Task] = []
        poll_tasks.append(
            asyncio.create_task(
                _poll_metrics_loop(
                    client=client,
                    orch_url=orch_url,
                    interval_s=poll_interval_s,
                    stop=stop,
                    out=metrics_series,
                )
            )
        )

        admin_token = ""
        if scenario.db_probe:
            admin_token = await _orch_login(orch_url, admin_user, admin_pass)
            if admin_token:
                poll_tasks.append(
                    asyncio.create_task(
                        _poll_db_loop(
                            client=client,
                            orch_url=orch_url,
                            token=admin_token,
                            kind=scenario.db_probe_kind,
                            interval_s=max(1.0, poll_interval_s),
                            stop=stop,
                            out=db_series,
                        )
                    )
                )
            else:
                db_series.append({"ts": _now_iso(), "kind": scenario.db_probe_kind, "ok": False, "status": 401, "ms": 0.0})

        in_flight_tasks: set[asyncio.Task] = set()

        async def spawn_one() -> None:
            if users:
                user_id = random.choice(users)
            else:
                user_id = None
            if orgs:
                org_id = random.choice(orgs)
            else:
                org_id = None
            source_app = random.choice(["EvigStudio", "EvigStudioLight", "api-client"]) 
            await _send_one(
                client=client,
                url=url,
                scenario=scenario,
                model=model,
                user_id=user_id,
                org_id=org_id,
                source_app=source_app,
                counters=counters,
                rates=rates,
                latencies_ms=latencies_ms,
                errors=errors,
                request_timeout_s=request_timeout_s,
            )

        async def live_loop() -> None:
            # Keep a small time series for sparklines.
            q_waiting: list[float] = []
            q_active: list[float] = []
            db_ms: list[float] = []
            last_print = 0.0
            while not stop.is_set():
                await asyncio.sleep(0.25)
                now = time.monotonic()
                if now - last_print < 1.0:
                    continue
                last_print = now

                latest_m = metrics_series[-1] if metrics_series else {}
                waiting_by_model = latest_m.get("waiting_by_model") or {}
                active_by_model = latest_m.get("active_by_model") or {}
                total_waiting = sum(int(v) for v in waiting_by_model.values())
                total_active = sum(int(v) for v in active_by_model.values())
                q_waiting.append(float(total_waiting))
                q_active.append(float(total_active))
                q_waiting[:] = q_waiting[-120:]
                q_active[:] = q_active[-120:]

                if db_series:
                    db_ms.append(float(db_series[-1].get("ms") or 0.0))
                    db_ms[:] = db_ms[-120:]

                elapsed_s = time.perf_counter() - start_wall
                r = rates.snapshot(time.monotonic())
                last_lat = latencies_ms[-2000:]  # tail window for quantiles
                p50 = _pct(last_lat, 0.50)
                p95 = _pct(last_lat, 0.95)
                p99 = _pct(last_lat, 0.99)
                avg = statistics.mean(last_lat) if last_lat else 0.0
                err_rate = (counters.failed / max(counters.sent, 1)) * 100

                sys.stdout.write(_ansi_clear())
                sys.stdout.write(f"Scenario: {scenario.name}\n")
                sys.stdout.write(f"Elapsed: {elapsed_s:6.1f}s  Target mix={scenario.mix}  stream_ratio={scenario.stream_ratio:.2f}  use_queue={scenario.use_queue}\n")
                sys.stdout.write(
                    f"Sent={counters.sent}  OK={counters.ok}  Failed={counters.failed}  Cancelled={counters.cancelled}  InFlight={counters.in_flight}  Err%={err_rate:5.2f}\n"
                )
                sys.stdout.write(
                    f"RPS(10s): sent={r['sent_rps']:.1f} ok={r['ok_rps']:.1f} fail={r['fail_rps']:.1f}  Lat(ms, last2k): avg={avg:.0f} p50={p50:.0f} p95={p95:.0f} p99={p99:.0f}\n"
                )
                sys.stdout.write(
                    f"Queue: active={total_active} waiting={total_waiting} workers={latest_m.get('workers_active')}\n"
                )
                sys.stdout.write(f"Queue waiting  { _sparkline(q_waiting, width=50) }\n")
                sys.stdout.write(f"Queue active   { _sparkline(q_active, width=50) }\n")
                if scenario.db_probe:
                    latest_db = db_series[-1] if db_series else {}
                    sys.stdout.write(
                        f"DB probe ({scenario.db_probe_kind}): ok={latest_db.get('ok')} status={latest_db.get('status')} ms={float(latest_db.get('ms') or 0.0):.0f}\n"
                    )
                    sys.stdout.write(f"DB probe ms    { _sparkline(db_ms, width=50) }\n")
                if errors:
                    sys.stdout.write("Recent errors:\n")
                    for e in list(errors)[-6:]:
                        sys.stdout.write(f"  {e}\n")
                sys.stdout.flush()

        live_task = asyncio.create_task(live_loop()) if enable_live else None

        try:
            for seg in scenario.segments:
                seg_start = time.monotonic()
                if seg.rps <= 0:
                    await asyncio.sleep(seg.duration_s)
                    continue

                interval = 1.0 / float(seg.rps)
                next_t = time.monotonic()
                while (time.monotonic() - seg_start) < seg.duration_s:
                    # Throttle to avoid unbounded local memory if orchestrator is slower than arrivals.
                    while len(in_flight_tasks) >= max_inflight:
                        done, pending = await asyncio.wait(
                            in_flight_tasks, return_when=asyncio.FIRST_COMPLETED, timeout=0.05
                        )
                        in_flight_tasks = set(pending)
                        for d in done:
                            # Surface task exceptions.
                            try:
                                d.result()
                            except Exception:
                                pass

                    now = time.monotonic()
                    if now < next_t:
                        await asyncio.sleep(next_t - now)
                    next_t += interval
                    t = asyncio.create_task(spawn_one())
                    in_flight_tasks.add(t)
                    # Reap quickly to avoid set growth.
                    if len(in_flight_tasks) > (max_inflight // 2):
                        done, pending = await asyncio.wait(in_flight_tasks, timeout=0.0)
                        in_flight_tasks = set(pending)
                        for d in done:
                            try:
                                d.result()
                            except Exception:
                                pass
        finally:
            # Drain outstanding.
            if in_flight_tasks:
                done, _ = await asyncio.wait(in_flight_tasks)
                for d in done:
                    try:
                        d.result()
                    except Exception:
                        pass

            stop.set()
            if live_task is not None:
                live_task.cancel()
                try:
                    await live_task
                except Exception:
                    pass
            for t in poll_tasks:
                t.cancel()
            await asyncio.gather(*poll_tasks, return_exceptions=True)

    wall_s = time.perf_counter() - start_wall
    achieved_rps = counters.ok / wall_s if wall_s > 0 else 0.0
    report = {
        "ts": _now_iso(),
        "scenario": scenario.name,
        "config": {
            "orch_url": orch_url,
            "chat_path": chat_path,
            "use_queue": scenario.use_queue,
            "mix": scenario.mix,
            "stream_ratio": scenario.stream_ratio,
            "max_tokens": scenario.max_tokens,
            "segments": [{"duration_s": s.duration_s, "rps": s.rps} for s in scenario.segments],
            "max_inflight": max_inflight,
            "request_timeout_s": request_timeout_s,
            "poll_interval_s": poll_interval_s,
            "db_probe": scenario.db_probe,
            "db_probe_kind": scenario.db_probe_kind,
        },
        "results": {
            "wall_s": wall_s,
            "sent": counters.sent,
            "ok": counters.ok,
            "failed": counters.failed,
            "cancelled": counters.cancelled,
            "achieved_ok_rps": achieved_rps,
            "http_429": counters.http_429,
            "http_5xx": counters.http_5xx,
            "other_http": counters.other_http,
            "latency_ms": {
                "avg": statistics.mean(latencies_ms) if latencies_ms else 0.0,
                "p50": _pct(latencies_ms, 0.50),
                "p95": _pct(latencies_ms, 0.95),
                "p99": _pct(latencies_ms, 0.99),
                "max": max(latencies_ms) if latencies_ms else 0.0,
            },
        },
        "series": {
            "metrics": metrics_series,
            "db": db_series,
        },
        "recent_errors": list(errors),
    }
    return report


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--orch-url", default="http://localhost:3013")
    p.add_argument("--chat-path", default=CHAT_PATH_DEFAULT)
    p.add_argument("--model", default="google/gemma-4-26b-a4b")
    p.add_argument("--scenario", default="all", help="all | warmup | steady_50rps_short | steady_50rps_mixed | bursty_avg_50rps | ramp_to_50rps | streaming_mix | multi_turn_sessions")
    p.add_argument("--rps", type=float, default=50.0)
    p.add_argument("--duration", type=float, default=180.0, help="duration used by steady scenarios")
    p.add_argument("--use-queue", action="store_true", default=True)
    p.add_argument("--no-use-queue", action="store_false", dest="use_queue")
    p.add_argument("--max-tokens", type=int, default=32)
    p.add_argument("--request-timeout", type=float, default=600.0)
    p.add_argument("--max-inflight", type=int, default=2000)
    p.add_argument("--poll-interval", type=float, default=1.0)
    p.add_argument("--users", type=int, default=200, help="number of distinct x-user-id values")
    p.add_argument("--orgs", type=int, default=20, help="number of distinct x-org-id values")
    p.add_argument("--no-identities", action="store_true", help="don’t send user/org ids")
    p.add_argument("--admin-user", default="admin")
    p.add_argument("--admin-pass", default="admin123")
    p.add_argument("--no-live", action="store_true")
    p.add_argument("--report", default="orchestrator_load_report.json")
    return p.parse_args()


async def main() -> None:
    args = _parse_args()

    scenarios = _default_scenarios(
        rps=float(args.rps),
        duration_s=float(args.duration),
        use_queue=bool(args.use_queue),
        max_tokens=int(args.max_tokens) if args.max_tokens >= 0 else 32,
    )
    if args.scenario != "all":
        scenarios = [s for s in scenarios if s.name == args.scenario]
        if not scenarios:
            raise SystemExit(f"Unknown scenario: {args.scenario}")

    users = None if args.no_identities else [f"u{i:04d}" for i in range(int(args.users))]
    orgs = None if args.no_identities else [f"o{i:03d}" for i in range(int(args.orgs))]

    all_reports: list[dict[str, Any]] = []
    for s in scenarios:
        # Small pause between scenarios so queues can settle (still visible in metrics).
        if all_reports:
            await asyncio.sleep(3.0)

        report = await _run_scenario(
            orch_url=args.orch_url.rstrip("/"),
            chat_path=args.chat_path,
            scenario=s,
            model=args.model,
            users=users,
            orgs=orgs,
            max_inflight=int(args.max_inflight),
            request_timeout_s=float(args.request_timeout),
            poll_interval_s=float(args.poll_interval),
            admin_user=args.admin_user,
            admin_pass=args.admin_pass,
            enable_live=not bool(args.no_live),
        )
        all_reports.append(report)

    out = {
        "ts": _now_iso(),
        "orch_url": args.orch_url,
        "reports": all_reports,
    }
    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=True, indent=2)
    # Print a small summary at the end.
    sys.stdout.write("\n\n")
    for rep in all_reports:
        r = rep["results"]
        lat = r["latency_ms"]
        sys.stdout.write(
            f"{rep['scenario']}: ok={r['ok']}/{r['sent']} failed={r['failed']} ok_rps={r['achieved_ok_rps']:.2f} "
            f"p95={lat['p95']:.0f}ms p99={lat['p99']:.0f}ms\n"
        )
    sys.stdout.write(f"\nWrote report: {args.report}\n")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
