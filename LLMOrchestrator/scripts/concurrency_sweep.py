from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx


def _now_s() -> float:
    return time.perf_counter()


def _pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    if len(values) == 1:
        return float(values[0])
    ordered = sorted(values)
    idx = (len(ordered) - 1) * p
    lo = int(math.floor(idx))
    hi = min(lo + 1, len(ordered) - 1)
    frac = idx - lo
    return ordered[lo] + (ordered[hi] - ordered[lo]) * frac


def _summary(values: list[float]) -> dict[str, float]:
    if not values:
        return {
            "count": 0,
            "avg_ms": float("nan"),
            "p50_ms": float("nan"),
            "p90_ms": float("nan"),
            "p95_ms": float("nan"),
            "p99_ms": float("nan"),
            "max_ms": float("nan"),
        }
    ms = [v * 1000.0 for v in values]
    return {
        "count": float(len(ms)),
        "avg_ms": float(statistics.fmean(ms)),
        "p50_ms": float(_pct(ms, 0.50)),
        "p90_ms": float(_pct(ms, 0.90)),
        "p95_ms": float(_pct(ms, 0.95)),
        "p99_ms": float(_pct(ms, 0.99)),
        "max_ms": float(max(ms)),
    }


@dataclass
class AdminSession:
    base_url: str
    token: str

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}


async def admin_login(
    client: httpx.AsyncClient, *, base_url: str, username: str, password: str
) -> AdminSession:
    r = await client.post(
        f"{base_url}/admin/login",
        json={"username": username, "password": password},
    )
    r.raise_for_status()
    data = r.json()
    return AdminSession(base_url=base_url, token=data["access_token"])


async def admin_get_models(client: httpx.AsyncClient, admin: AdminSession) -> list[dict[str, Any]]:
    r = await client.get(f"{admin.base_url}/admin/models", headers=admin.headers)
    r.raise_for_status()
    return list(r.json())


async def admin_get_config(client: httpx.AsyncClient, admin: AdminSession) -> list[dict[str, Any]]:
    r = await client.get(f"{admin.base_url}/admin/config", headers=admin.headers)
    r.raise_for_status()
    return list(r.json())


async def admin_set_config(
    client: httpx.AsyncClient,
    admin: AdminSession,
    *,
    key: str,
    value_json: Any,
) -> None:
    r = await client.put(
        f"{admin.base_url}/admin/config/{key}",
        headers=admin.headers,
        json={"value_json": value_json},
    )
    r.raise_for_status()


async def admin_update_model(
    client: httpx.AsyncClient,
    admin: AdminSession,
    *,
    model_name: str,
    updates: dict[str, Any],
) -> None:
    # Model names can contain slashes; path param is declared with :path.
    r = await client.put(
        f"{admin.base_url}/admin/models/{quote(model_name, safe='')}",
        headers=admin.headers,
        json=updates,
    )
    r.raise_for_status()


def _pick_default_model(config_rows: list[dict[str, Any]]) -> str | None:
    for row in config_rows:
        if row.get("key") == "default_model":
            v = row.get("value_json")
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def _find_model_row(models: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for m in models:
        if m.get("name") == name:
            return m
    for m in models:
        if m.get("alias") == name:
            return m
    return None


async def _one_request(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    model: str,
    user_id: str,
    request_no: int,
    timeout_s: float,
) -> tuple[bool, float, int | None]:
    prompt = (
        "You are a helpful assistant. Answer in one short paragraph.\n\n"
        f"Unique user task id={user_id} req={request_no}: "
        "Explain the difference between throughput and latency with one concrete example."
    )
    payload = {
        "model": model,
        "stream": False,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 120,
    }
    headers = {
        "x-source-app": "concurrency_sweep",
        "x-user-id": user_id,
        "x-trace-id": f"sweep-{user_id}-{request_no}",
    }
    started = _now_s()
    try:
        r = await client.post(
            f"{base_url}/v1/chat/completions",
            json=payload,
            headers=headers,
            timeout=timeout_s,
        )
        ok = r.status_code == 200
        return ok, _now_s() - started, r.status_code
    except Exception:
        return False, _now_s() - started, None


async def run_load(
    *,
    base_url: str,
    model: str,
    users: int,
    duration_s: int,
    warmup_s: int,
    timeout_s: float,
) -> dict[str, Any]:
    end_at = _now_s() + duration_s
    warmup_end = _now_s() + warmup_s

    latencies: list[float] = []
    warmup_latencies: list[float] = []
    status_counts: dict[str, int] = {}
    errors = 0
    successes = 0
    total = 0

    limits = httpx.Limits(
        max_connections=max(100, users * 4),
        max_keepalive_connections=max(20, users * 2),
        keepalive_expiry=30.0,
    )

    async with httpx.AsyncClient(limits=limits) as client:

        async def user_loop(i: int) -> None:
            nonlocal errors, successes, total
            user_id = f"user-{i:03d}"
            n = 0
            # Small deterministic stagger avoids a thundering herd at t=0.
            await asyncio.sleep((i % 10) * 0.02)
            while _now_s() < end_at:
                n += 1
                ok, dt, status = await _one_request(
                    client,
                    base_url=base_url,
                    model=model,
                    user_id=user_id,
                    request_no=n,
                    timeout_s=timeout_s,
                )
                total += 1
                key = "timeout_or_network" if status is None else str(status)
                status_counts[key] = status_counts.get(key, 0) + 1
                if ok:
                    successes += 1
                    if _now_s() < warmup_end:
                        warmup_latencies.append(dt)
                    else:
                        latencies.append(dt)
                else:
                    errors += 1
                # Minimal think-time so each "user" is a sequential session.
                await asyncio.sleep(0.01 + random.random() * 0.02)

        tasks = [asyncio.create_task(user_loop(i)) for i in range(users)]
        await asyncio.gather(*tasks)

    elapsed_s = duration_s
    return {
        "users": users,
        "duration_s": duration_s,
        "warmup_s": warmup_s,
        "model": model,
        "requests_total": total,
        "successes": successes,
        "errors": errors,
        "rps": (successes / max(elapsed_s - warmup_s, 1)) if elapsed_s > warmup_s else 0.0,
        "status_counts": status_counts,
        "latency": _summary(latencies),
        "warmup_latency": _summary(warmup_latencies),
    }


async def main() -> int:
    ap = argparse.ArgumentParser(
        description="Sweep orchestrator concurrency knobs and measure user-perceived latency."
    )
    ap.add_argument("--base-url", default=os.environ.get("ORCH_URL", "http://127.0.0.1:3013"))
    ap.add_argument("--admin-user", default=os.environ.get("ORCH_ADMIN_USER", "admin"))
    ap.add_argument("--admin-pass", default=os.environ.get("ORCH_ADMIN_PASS", "admin123"))
    ap.add_argument("--users", type=int, default=30)
    ap.add_argument("--duration-s", type=int, default=180)
    ap.add_argument("--warmup-s", type=int, default=20)
    ap.add_argument("--timeout-s", type=float, default=180.0)
    ap.add_argument(
        "--values",
        default="2,4,8,10",
        help="Comma-separated sweep values (default: 2,4,8,10)",
    )
    ap.add_argument(
        "--mode",
        default="all",
        choices=["model_only", "worker_only", "both", "all"],
        help="Which sweep to run.",
    )
    ap.add_argument(
        "--output",
        default="concurrency_sweep_results.json",
        help="Write results JSON here.",
    )
    args = ap.parse_args()

    base_url = args.base_url.rstrip("/")
    values = [int(v.strip()) for v in str(args.values).split(",") if v.strip()]
    values = [v for v in values if v >= 1]
    if not values:
        raise SystemExit("No valid sweep values")

    async with httpx.AsyncClient(timeout=10.0) as admin_client:
        admin = await admin_login(
            admin_client,
            base_url=base_url,
            username=args.admin_user,
            password=args.admin_pass,
        )
        config = await admin_get_config(admin_client, admin)
        models = await admin_get_models(admin_client, admin)
        default_model = _pick_default_model(config)
        if not default_model:
            raise SystemExit("Could not determine default_model from /admin/config")
        model_row = _find_model_row(models, default_model)
        if not model_row:
            raise SystemExit(f"default_model '{default_model}' not found in /admin/models")
        target_model_name = str(model_row["name"])

        # Snapshot baseline to restore at end.
        baseline = {
            "model_concurrency_limit": int(model_row.get("concurrency_limit") or 1),
        }
        for row in config:
            k = row.get("key")
            if k in {
                "worker_max_parallel_jobs",
                "worker_sqlite_max_parallel_jobs",
                "scheduler_acquire_timeout_seconds",
            }:
                baseline[k] = row.get("value_json")

        results: list[dict[str, Any]] = []

        async def apply_common(*, worker: int, sqlite_worker: int) -> None:
            await admin_set_config(admin_client, admin, key="worker_max_parallel_jobs", value_json=worker)
            await admin_set_config(
                admin_client,
                admin,
                key="worker_sqlite_max_parallel_jobs",
                value_json=sqlite_worker,
            )
            # Allow scheduler to wait longer than default so higher contention doesn't
            # turn into avoidable failures.
            await admin_set_config(
                admin_client,
                admin,
                key="scheduler_acquire_timeout_seconds",
                value_json=max(5, worker),
            )

        async def apply_model_limit(limit: int) -> None:
            await admin_update_model(
                admin_client,
                admin,
                model_name=target_model_name,
                updates={"concurrency_limit": int(limit)},
            )

        modes = [args.mode] if args.mode != "all" else ["model_only", "worker_only", "both"]

        for mode in modes:
            if mode == "model_only":
                # Make worker not the bottleneck for the sweep.
                await apply_common(worker=max(values), sqlite_worker=max(values))
                for limit in values:
                    await apply_model_limit(limit)
                    # Small settle time for worker runtime refresh.
                    await asyncio.sleep(2.0)
                    run = await run_load(
                        base_url=base_url,
                        model=target_model_name,
                        users=args.users,
                        duration_s=args.duration_s,
                        warmup_s=args.warmup_s,
                        timeout_s=args.timeout_s,
                    )
                    results.append({"mode": mode, "model_concurrency_limit": limit, "worker": max(values), "sqlite_worker": max(values), "run": run})

            if mode == "worker_only":
                await apply_model_limit(max(values))
                for worker in values:
                    await apply_common(worker=worker, sqlite_worker=worker)
                    await asyncio.sleep(2.0)
                    run = await run_load(
                        base_url=base_url,
                        model=target_model_name,
                        users=args.users,
                        duration_s=args.duration_s,
                        warmup_s=args.warmup_s,
                        timeout_s=args.timeout_s,
                    )
                    results.append({"mode": mode, "model_concurrency_limit": max(values), "worker": worker, "sqlite_worker": worker, "run": run})

            if mode == "both":
                for v in values:
                    await apply_model_limit(v)
                    await apply_common(worker=v, sqlite_worker=v)
                    await asyncio.sleep(2.0)
                    run = await run_load(
                        base_url=base_url,
                        model=target_model_name,
                        users=args.users,
                        duration_s=args.duration_s,
                        warmup_s=args.warmup_s,
                        timeout_s=args.timeout_s,
                    )
                    results.append({"mode": mode, "model_concurrency_limit": v, "worker": v, "sqlite_worker": v, "run": run})

        # Restore baseline.
        try:
            await apply_model_limit(int(baseline.get("model_concurrency_limit") or 1))
        except Exception:
            pass
        for k in (
            "worker_max_parallel_jobs",
            "worker_sqlite_max_parallel_jobs",
            "scheduler_acquire_timeout_seconds",
        ):
            if k in baseline:
                try:
                    await admin_set_config(admin_client, admin, key=k, value_json=baseline[k])
                except Exception:
                    pass

    # Print a readable table.
    def line(row: dict[str, Any]) -> str:
        run = row["run"]
        lat = run["latency"]
        return (
            f"{row['mode']:<10} model={row['model_concurrency_limit']:<2} "
            f"worker={row['worker']:<2} ok={run['successes']:<5} err={run['errors']:<5} "
            f"p50={lat['p50_ms']:.0f}ms p95={lat['p95_ms']:.0f}ms p99={lat['p99_ms']:.0f}ms "
            f"rps={run['rps']:.2f}"
        )

    print("\nResults:")
    for row in results:
        print(line(row))

    out = {
        "base_url": base_url,
        "values": values,
        "users": args.users,
        "duration_s": args.duration_s,
        "warmup_s": args.warmup_s,
        "timeout_s": args.timeout_s,
        "results": results,
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"\nWrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
