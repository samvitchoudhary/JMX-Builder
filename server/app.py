"""Flask backend that runs JMeter test plans and streams results via SSE.

Endpoints:
    POST /api/run                  start a run, returns {runId}
    GET  /api/run/<id>/stream      Server-Sent Events stream
    POST /api/run/<id>/stop        SIGTERM the JMeter process
    GET  /api/health               { ok: true, jmeter_version }

Each run lives in a temp dir (RUNS_BASE/<runId>/) containing plan.jmx,
results.jtl, and jmeter.log. After the run completes the dir is deleted
60 seconds later (giving the SSE client a chance to drain its buffer).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

from jmx_builder import build_jmx
from jtl_parser import JtlTailer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("jmx-backend")

# Hard limits, mirrored on the frontend.
MAX_THREADS = 5000
MAX_RAMPUP_SECONDS = 3600
MAX_LOOPS = 10000

RUN_TIMEOUT_SECONDS = 10 * 60  # 10 minutes
CLEANUP_DELAY_SECONDS = 60
JTL_POLL_INTERVAL = 0.25  # seconds between tail polls
PROGRESS_INTERVAL = 0.5  # seconds between progress events

RUNS_BASE = Path(os.environ.get("JMX_RUNS_DIR", "/tmp/jmx-runs"))
JMETER_BIN = os.environ.get("JMETER_BIN", "jmeter")

# Sentinel pushed onto a run's event queue once no more events will arrive.
_END_OF_STREAM: dict = {"__end__": True}


@dataclass
class Run:
    run_id: str
    work_dir: Path
    total_samples: int
    proc: subprocess.Popen | None = None
    events: "queue.Queue[dict]" = field(default_factory=queue.Queue)
    stop_requested: threading.Event = field(default_factory=threading.Event)
    finished: threading.Event = field(default_factory=threading.Event)


# Module-level registry. Flask handlers run in worker threads; the dict is
# guarded by a lock for create/lookup/delete. Per-run state lives inside the
# Run object and is hit only from the worker thread (and a couple of read-
# only fields like `proc` from /stop).
_runs: dict[str, Run] = {}
_runs_lock = threading.Lock()


def create_app() -> Flask:
    app = Flask(__name__)
    # Single-tenant for now; permissive CORS so the React dev server (and a
    # separately-deployed prod frontend) can hit us.
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    @app.get("/api/health")
    def health() -> Response:
        return jsonify({"ok": True, "jmeter_version": _jmeter_version()})

    @app.post("/api/run")
    def start_run() -> Response:
        body = request.get_json(silent=True) or {}
        try:
            cfg = _validate_config(body)
        except ValueError as exc:
            return _json_error(str(exc), status=400)

        run_id = uuid.uuid4().hex
        work_dir = RUNS_BASE / run_id
        try:
            work_dir.mkdir(parents=True, exist_ok=True)
            jmx_text = build_jmx(cfg)
            (work_dir / "plan.jmx").write_text(jmx_text, encoding="utf-8")
        except (OSError, ValueError) as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            return _json_error(f"Failed to prepare run: {exc}", status=400)

        total = int(cfg["threads"]) * int(cfg["loops"])
        run = Run(run_id=run_id, work_dir=work_dir, total_samples=total)
        with _runs_lock:
            _runs[run_id] = run

        worker = threading.Thread(
            target=_execute_run, args=(run,), name=f"jmx-run-{run_id[:8]}", daemon=True
        )
        worker.start()

        log.info("run %s queued (threads=%s loops=%s)", run_id, cfg["threads"], cfg["loops"])
        return jsonify({"runId": run_id})

    @app.get("/api/run/<run_id>/stream")
    def stream(run_id: str) -> Response:
        with _runs_lock:
            run = _runs.get(run_id)
        if run is None:
            return _json_error("Unknown runId", status=404)

        @stream_with_context
        def gen():
            # Keepalive comment so proxies know the connection is alive even
            # when no events are flowing.
            yield ": connected\n\n"
            while True:
                try:
                    evt = run.events.get(timeout=15)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue

                if evt.get("__end__"):
                    return

                event_name = evt.get("event", "message")
                data = evt.get("data", {})
                yield f"event: {event_name}\ndata: {json.dumps(data)}\n\n"

        return Response(
            gen(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",  # disable nginx buffering when behind one
                "Connection": "keep-alive",
            },
        )

    @app.post("/api/run/<run_id>/stop")
    def stop(run_id: str) -> Response:
        with _runs_lock:
            run = _runs.get(run_id)
        if run is None:
            return _json_error("Unknown runId", status=404)

        run.stop_requested.set()
        proc = run.proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            except OSError as exc:
                log.warning("run %s: terminate failed: %s", run_id, exc)
        log.info("run %s: stop requested", run_id)
        return jsonify({"ok": True})

    return app


# --------------------------- run lifecycle ----------------------------------


def _execute_run(run: Run) -> None:
    """Worker thread: spawn JMeter, tail JTL, push events, then clean up."""
    jmx_path = run.work_dir / "plan.jmx"
    jtl_path = run.work_dir / "results.jtl"
    log_path = run.work_dir / "jmeter.log"

    cmd = [
        JMETER_BIN, "-n",
        "-t", str(jmx_path),
        "-l", str(jtl_path),
        "-j", str(log_path),
        "-Jjmeter.save.saveservice.output_format=csv",
        "-Jjmeter.save.saveservice.assertion_results=all",
        "-Jjmeter.save.saveservice.print_field_names=true",
    ]

    log.info("run %s: launching: %s", run.run_id, " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(run.work_dir),
        )
    except FileNotFoundError:
        _push_error(run, "JMeter binary not found. Is it on PATH?")
        _finalize(run)
        return
    except OSError as exc:
        _push_error(run, f"Failed to launch JMeter: {exc}")
        _finalize(run)
        return

    run.proc = proc

    tailer = JtlTailer(str(jtl_path))
    sent_done = 0
    last_progress_at = 0.0
    started_at = time.monotonic()
    timed_out = False

    try:
        while True:
            # Drain whatever new rows have appeared in the JTL.
            new_count = 0
            for sample in tailer.read_new():
                run.events.put({"event": "sample", "data": sample})
                sent_done += 1
                new_count += 1

            now = time.monotonic()
            if new_count > 0 or (now - last_progress_at) >= PROGRESS_INTERVAL:
                run.events.put(
                    {"event": "progress", "data": {"done": sent_done, "total": run.total_samples}}
                )
                last_progress_at = now

            if proc.poll() is not None:
                break

            if run.stop_requested.is_set() and proc.poll() is None:
                # /stop already SIGTERM'd; give it a beat to exit cleanly,
                # then SIGKILL if it's still alive.
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                break

            if (now - started_at) > RUN_TIMEOUT_SECONDS:
                timed_out = True
                try:
                    proc.terminate()
                    proc.wait(timeout=10)
                except (subprocess.TimeoutExpired, OSError):
                    try:
                        proc.kill()
                    except OSError:
                        pass
                break

            time.sleep(JTL_POLL_INTERVAL)
    except Exception as exc:  # noqa: BLE001
        log.exception("run %s: tailer crashed", run.run_id)
        _push_error(run, f"Internal error: {exc}")
        _terminate(proc)

    # Final drain (subprocess has exited, but the tailer might have buffered
    # data that hadn't been flushed before the last poll).
    try:
        for sample in tailer.read_new():
            run.events.put({"event": "sample", "data": sample})
            sent_done += 1
    except Exception:  # noqa: BLE001
        log.exception("run %s: final drain failed", run.run_id)

    run.events.put(
        {"event": "progress", "data": {"done": sent_done, "total": run.total_samples}}
    )

    exit_code = proc.poll()
    stderr_tail = _tail_stream(proc.stderr)

    if timed_out:
        _push_error(run, f"Run exceeded {RUN_TIMEOUT_SECONDS}s timeout and was killed.")
    elif run.stop_requested.is_set():
        # User-requested stop is not an error condition — emit complete with
        # a "stopped" flag so the UI can label it.
        run.events.put(
            {
                "event": "complete",
                "data": {
                    "stats": {"total": sent_done, "exitCode": exit_code, "stopped": True},
                },
            }
        )
    elif exit_code != 0:
        msg = f"JMeter exited with code {exit_code}."
        if stderr_tail:
            msg = f"{msg}\n{stderr_tail}"
        _push_error(run, msg)
    else:
        run.events.put(
            {
                "event": "complete",
                "data": {"stats": {"total": sent_done, "exitCode": exit_code}},
            }
        )

    _finalize(run)
    log.info(
        "run %s: done (samples=%s exit=%s stopped=%s timed_out=%s)",
        run.run_id, sent_done, exit_code, run.stop_requested.is_set(), timed_out,
    )


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def _tail_stream(stream: Any, max_bytes: int = 2000) -> str:
    if stream is None:
        return ""
    try:
        data = stream.read() or b""
    except (ValueError, OSError):
        return ""
    if not data:
        return ""
    text = data.decode("utf-8", errors="replace")
    return text[-max_bytes:]


def _push_error(run: Run, message: str) -> None:
    run.events.put({"event": "error", "data": {"message": message}})


def _finalize(run: Run) -> None:
    """Emit end-of-stream sentinel and schedule cleanup."""
    run.finished.set()
    run.events.put(_END_OF_STREAM)
    cleaner = threading.Thread(
        target=_cleanup_after_delay,
        args=(run.run_id, CLEANUP_DELAY_SECONDS),
        name=f"jmx-cleanup-{run.run_id[:8]}",
        daemon=True,
    )
    cleaner.start()


def _cleanup_after_delay(run_id: str, delay: float) -> None:
    time.sleep(delay)
    with _runs_lock:
        run = _runs.pop(run_id, None)
    if run is None:
        return
    try:
        shutil.rmtree(run.work_dir, ignore_errors=True)
    except OSError as exc:
        log.warning("run %s: cleanup failed: %s", run_id, exc)
    log.info("run %s: cleaned up", run_id)


# --------------------------- helpers ----------------------------------------


def _validate_config(body: dict) -> dict:
    """Coerce/validate the incoming JSON. Raises ValueError on bad input."""
    threads = _coerce_positive_int(body.get("threads"), "threads", default=1)
    ramp_up = _coerce_nonneg_int(body.get("rampUp"), "rampUp", default=0)
    loops = _coerce_positive_int(body.get("loops"), "loops", default=1)

    if threads > MAX_THREADS:
        raise ValueError(f"threads must be ≤ {MAX_THREADS}")
    if ramp_up > MAX_RAMPUP_SECONDS:
        raise ValueError(f"rampUp must be ≤ {MAX_RAMPUP_SECONDS} seconds")
    if loops > MAX_LOOPS:
        raise ValueError(f"loops must be ≤ {MAX_LOOPS}")

    url = (body.get("url") or "").strip()
    if not url:
        raise ValueError("url is required")

    return {
        "testPlanName": body.get("testPlanName") or "Test Plan",
        "threadGroupName": body.get("threadGroupName") or "Thread Group",
        "url": url,
        "method": body.get("method") or "GET",
        "contentType": body.get("contentType") or "",
        "body": body.get("body") or "",
        "headers": body.get("headers") or [],
        "threads": threads,
        "rampUp": ramp_up,
        "loops": loops,
        "assertions": body.get("assertions") or {},
    }


def _coerce_positive_int(value: Any, name: str, *, default: int) -> int:
    n = _coerce_nonneg_int(value, name, default=default)
    if n < 1:
        return 1
    return n


def _coerce_nonneg_int(value: Any, name: str, *, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if n < 0:
        raise ValueError(f"{name} must be ≥ 0")
    return n


def _json_error(message: str, *, status: int) -> Response:
    resp = jsonify({"error": message})
    resp.status_code = status
    return resp


_VERSION_RE = re.compile(r"\b\d+\.\d+(?:\.\d+)?\b")


def _jmeter_version() -> str | None:
    """Best-effort JMeter version probe. Cached per-process."""
    cached = _jmeter_version_cache.get("v")
    if cached is not None:
        return cached or None
    try:
        proc = subprocess.run(
            [JMETER_BIN, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        text = (proc.stdout or "") + "\n" + (proc.stderr or "")
        m = _VERSION_RE.search(text)
        version = m.group(0) if m else ""
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        version = ""
    _jmeter_version_cache["v"] = version
    return version or None


_jmeter_version_cache: dict[str, str] = {}

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    # threaded=True so SSE streams don't block other requests under the dev
    # server. Production should use gunicorn (see Dockerfile).
    app.run(host="0.0.0.0", port=port, threaded=True)
