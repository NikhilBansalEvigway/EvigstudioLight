from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from sqlalchemy import delete, func, select


def _set_env_defaults() -> None:
    # Keep these defaults aligned with app/core/settings.py.
    os.environ.setdefault("DATABASE_SQLITE_BUSY_TIMEOUT_SECONDS", "30")
    os.environ.setdefault("DATABASE_SQLITE_LOCK_RETRY_ATTEMPTS", "8")
    os.environ.setdefault("DATABASE_SQLITE_LOCK_RETRY_BASE_DELAY_MS", "40")
    os.environ.setdefault("DATABASE_SQLITE_LOCK_RETRY_MAX_DELAY_MS", "2000")
    os.environ.setdefault("WORKER_SQLITE_MAX_PARALLEL_JOBS", "1")


def _set_database_url(url: str) -> None:
    os.environ["DATABASE_URL"] = url
    # Settings are cached.
    from app.core.settings import get_settings

    get_settings.cache_clear()


async def _init_db() -> None:
    from app.db.session import dispose_engine, initialize_database

    try:
        await initialize_database()
    finally:
        await dispose_engine()


async def _count_rows(model) -> int:
    from app.db.session import get_session_factory

    session_factory = get_session_factory()
    async with session_factory() as session:
        result = await session.execute(select(func.count()).select_from(model))
        return int(result.scalar_one() or 0)


async def _scenario_single_process_many_writes(
    *, inserts: int, concurrency: int
) -> None:
    from app.db.session import dispose_engine, get_session_factory, initialize_database
    from app.models.llm_request import LLMRequest
    from app.services.request_store import RequestStore

    await initialize_database()

    session_factory = get_session_factory()
    store = RequestStore()
    sem = asyncio.Semaphore(max(1, concurrency))

    async def do_one(i: int) -> None:
        async with sem:
            async with session_factory() as session:
                async with session.begin():
                    await store.create_request(
                        session,
                        request_id=str(uuid.uuid4()),
                        trace_id=str(uuid.uuid4()),
                        source_app="db_lock_test",
                        user_id="u",
                        org_id="o",
                        requested_model="m",
                        resolved_model="m",
                        backend_url="http://example",
                        request_payload_json={"model": "m", "messages": []},
                        input_text=None,
                        status="queued",
                        event_type="queued",
                        event_details_json={"i": i, "mode": "test"},
                    )

    started = time.perf_counter()
    await asyncio.gather(*[do_one(i) for i in range(inserts)])
    took_ms = int((time.perf_counter() - started) * 1000)

    total = await _count_rows(LLMRequest)
    if total < inserts:
        raise RuntimeError(f"expected >= {inserts} llm_requests, got {total}")
    print(f"single_process_many_writes ok inserts={inserts} concurrency={concurrency} took_ms={took_ms}")

    await dispose_engine()


async def _scenario_init_race(*, processes: int) -> None:
    # Run initialize_database in multiple processes pointing at the same SQLite file.
    args = [sys.executable, __file__, "child", "init"]
    procs = [subprocess.Popen(args, env=os.environ.copy()) for _ in range(processes)]
    codes = [p.wait() for p in procs]
    bad = [c for c in codes if c != 0]
    if bad:
        raise RuntimeError(f"init_race failed exit_codes={codes}")
    print(f"init_race ok processes={processes}")


async def _scenario_two_processes_concurrent_writes(
    *, processes: int, inserts_per_process: int, concurrency: int
) -> None:
    args = [
        sys.executable,
        __file__,
        "child",
        "write",
        "--inserts",
        str(inserts_per_process),
        "--concurrency",
        str(concurrency),
    ]
    procs = [subprocess.Popen(args, env=os.environ.copy()) for _ in range(processes)]
    codes = [p.wait() for p in procs]
    bad = [c for c in codes if c != 0]
    if bad:
        raise RuntimeError(f"two_processes_write failed exit_codes={codes}")

    from app.models.llm_request import LLMRequest

    expected_min = processes * inserts_per_process
    total = await _count_rows(LLMRequest)
    if total < expected_min:
        raise RuntimeError(f"expected >= {expected_min} llm_requests, got {total}")
    print(
        "two_processes_write ok "
        f"processes={processes} inserts_per_process={inserts_per_process} concurrency={concurrency}"
    )


async def _scenario_api_worker_sim(
    *, jobs: int, api_concurrency: int, worker_concurrency: int
) -> None:
    # API process creates queued rows; worker process transitions them to completed.
    args_api = [
        sys.executable,
        __file__,
        "child",
        "api",
        "--jobs",
        str(jobs),
        "--concurrency",
        str(api_concurrency),
    ]
    args_worker = [
        sys.executable,
        __file__,
        "child",
        "worker",
        "--jobs",
        str(jobs),
        "--concurrency",
        str(worker_concurrency),
    ]
    api = subprocess.Popen(args_api, env=os.environ.copy())
    worker = subprocess.Popen(args_worker, env=os.environ.copy())

    api_code = api.wait()
    worker_code = worker.wait()
    if api_code != 0 or worker_code != 0:
        raise RuntimeError(f"api_worker_sim failed api={api_code} worker={worker_code}")

    from app.db.session import get_session_factory
    from app.models.queue_job import QueueJob

    session_factory = get_session_factory()
    async with session_factory() as session:
        result = await session.execute(
            select(func.count()).select_from(QueueJob).where(QueueJob.status == "completed")
        )
        completed = int(result.scalar_one() or 0)
    if completed < jobs:
        raise RuntimeError(f"expected >= {jobs} completed queue_jobs, got {completed}")
    print(
        "api_worker_sim ok "
        f"jobs={jobs} api_concurrency={api_concurrency} worker_concurrency={worker_concurrency}"
    )


async def _child_init() -> None:
    await _init_db()


async def _child_write(*, inserts: int, concurrency: int) -> None:
    from app.db.session import dispose_engine, get_session_factory, initialize_database
    from app.services.request_store import RequestStore

    await initialize_database()
    session_factory = get_session_factory()
    store = RequestStore()
    sem = asyncio.Semaphore(max(1, concurrency))

    async def do_one(i: int) -> None:
        async with sem:
            async with session_factory() as session:
                async with session.begin():
                    await store.create_request(
                        session,
                        request_id=str(uuid.uuid4()),
                        trace_id=str(uuid.uuid4()),
                        source_app="db_lock_child",
                        user_id="u",
                        org_id="o",
                        requested_model="m",
                        resolved_model="m",
                        backend_url="http://example",
                        request_payload_json={"model": "m", "messages": []},
                        input_text=None,
                        status="queued",
                        event_type="queued",
                        event_details_json={"i": i},
                    )

    await asyncio.gather(*[do_one(i) for i in range(inserts)])
    await dispose_engine()


async def _child_api(*, jobs: int, concurrency: int) -> None:
    from app.db.session import dispose_engine, get_session_factory, initialize_database
    from app.models.queue_job import QueueJob
    from app.services.request_store import RequestStore

    await initialize_database()
    session_factory = get_session_factory()
    store = RequestStore()
    sem = asyncio.Semaphore(max(1, concurrency))

    async def create_job(i: int) -> None:
        async with sem:
            request_id = str(uuid.uuid4())
            job_id = str(uuid.uuid4())
            async with session_factory() as session:
                async with session.begin():
                    await store.create_request(
                        session,
                        request_id=request_id,
                        trace_id=str(uuid.uuid4()),
                        source_app="api_sim",
                        user_id="u",
                        org_id="o",
                        requested_model="m",
                        resolved_model="m",
                        backend_url="http://example",
                        request_payload_json={"model": "m", "messages": []},
                        input_text=None,
                        status="queued",
                        event_type="queued",
                        event_details_json={"job_id": job_id, "i": i},
                    )
                    session.add(
                        QueueJob(
                            job_id=job_id,
                            request_id=request_id,
                            model_name="m",
                            status="queued",
                        )
                    )

    await asyncio.gather(*[create_job(i) for i in range(jobs)])
    await dispose_engine()


async def _child_worker(*, jobs: int, concurrency: int) -> None:
    from app.db.session import dispose_engine, get_session_factory, initialize_database
    from app.models.queue_job import QueueJob

    await initialize_database()
    session_factory = get_session_factory()
    sem = asyncio.Semaphore(max(1, concurrency))

    # Keep scanning until we've completed at least `jobs` rows.
    completed = 0

    async def process_one(job_id: str) -> None:
        nonlocal completed
        async with sem:
            async with session_factory() as session:
                async with session.begin():
                    result = await session.execute(
                        select(QueueJob).where(QueueJob.job_id == job_id).limit(1)
                    )
                    row = result.scalar_one_or_none()
                    if row is None:
                        return
                    if row.status != "completed":
                        row.status = "completed"
                        completed += 1

    seen: set[str] = set()
    deadline = time.monotonic() + 30
    while completed < jobs and time.monotonic() < deadline:
        async with session_factory() as session:
            result = await session.execute(
                select(QueueJob.job_id)
                .where(QueueJob.status == "queued")
                .order_by(QueueJob.queued_at.asc())
                .limit(200)
            )
            ids = [str(r[0]) for r in result.all()]
        new_ids = [jid for jid in ids if jid not in seen]
        if not new_ids:
            await asyncio.sleep(0.05)
            continue
        seen.update(new_ids)
        await asyncio.gather(*[process_one(jid) for jid in new_ids])

    if completed < jobs:
        raise RuntimeError(f"worker_sim timed out completed={completed} expected={jobs}")
    await dispose_engine()


async def _child_cleanup() -> None:
    from app.db.session import dispose_engine, get_session_factory, initialize_database
    from app.models.llm_request import LLMRequest
    from app.models.queue_job import QueueJob
    from app.models.llm_request_event import LLMRequestEvent
    from app.models.llm_response import LLMResponse

    await initialize_database()
    session_factory = get_session_factory()
    async with session_factory() as session:
        async with session.begin():
            # Clean in dependency order.
            await session.execute(delete(LLMResponse))
            await session.execute(delete(LLMRequestEvent))
            await session.execute(delete(QueueJob))
            await session.execute(delete(LLMRequest))
    await dispose_engine()


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SQLite lock contention test scenarios")
    p.add_argument(
        "mode",
        choices=["run", "child"],
        help="Parent runner or child worker",
    )
    p.add_argument(
        "scenario",
        choices=["all", "init_race", "single", "two_proc", "api_worker", "init", "write", "api", "worker", "cleanup"],
        help="Scenario to run",
    )
    p.add_argument("--db", default="", help="SQLite DB file path")
    p.add_argument("--processes", type=int, default=2)
    p.add_argument("--inserts", type=int, default=200)
    p.add_argument("--jobs", type=int, default=200)
    p.add_argument("--concurrency", type=int, default=50)
    p.add_argument("--api-concurrency", type=int, default=50)
    p.add_argument("--worker-concurrency", type=int, default=10)
    return p.parse_args(argv)


async def _run_parent(args: argparse.Namespace) -> None:
    _set_env_defaults()

    if args.db:
        db_path = Path(args.db).resolve()
        db_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        tmp = Path(tempfile.mkdtemp(prefix="llm_orc_db_lock_test_"))
        db_path = tmp / "llm_orchestrator_test.db"

    url = f"sqlite+aiosqlite:////{db_path.as_posix().lstrip('/')}" if db_path.is_absolute() else f"sqlite+aiosqlite:///{db_path.as_posix()}"
    _set_database_url(url)

    # Ensure a clean slate.
    await _child_cleanup()

    if args.scenario in {"all", "init_race"}:
        await _scenario_init_race(processes=args.processes)
    if args.scenario in {"all", "single"}:
        await _scenario_single_process_many_writes(inserts=args.inserts, concurrency=args.concurrency)
    if args.scenario in {"all", "two_proc"}:
        await _scenario_two_processes_concurrent_writes(
            processes=args.processes,
            inserts_per_process=args.inserts,
            concurrency=max(1, args.concurrency // 5),
        )
    if args.scenario in {"all", "api_worker"}:
        await _scenario_api_worker_sim(
            jobs=args.jobs,
            api_concurrency=args.api_concurrency,
            worker_concurrency=args.worker_concurrency,
        )


async def _run_child(args: argparse.Namespace) -> None:
    _set_env_defaults()
    if args.scenario == "init":
        await _child_init()
        return
    if args.scenario == "cleanup":
        await _child_cleanup()
        return
    if args.scenario == "write":
        await _child_write(inserts=args.inserts, concurrency=args.concurrency)
        return
    if args.scenario == "api":
        await _child_api(jobs=args.jobs, concurrency=args.concurrency)
        return
    if args.scenario == "worker":
        await _child_worker(jobs=args.jobs, concurrency=args.concurrency)
        return
    raise SystemExit(f"unknown child scenario: {args.scenario}")


def main(argv: list[str]) -> int:
    args = _parse_args(argv)
    try:
        if args.mode == "run":
            asyncio.run(_run_parent(args))
        else:
            asyncio.run(_run_child(args))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
