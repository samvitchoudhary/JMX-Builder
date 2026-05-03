"""Incrementally parse a JMeter JTL CSV file as it's being written.

The JTL CSV columns (with the default JMeter save settings we pass on the
command line) are:

  timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,
  success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,
  IdleTime,Connect

We tail the file by tracking the byte offset between polls, splitting on
newlines, and parsing each completed row with csv.reader. A trailing partial
line (no newline yet) is held until the next poll.

Each parsed row becomes a sample dict shaped like:

    {
        "id":        "<seq>-<threadNum>-<iteration>",
        "threadNum": int,           # parsed from threadName "TG <grp>-<thread>"
        "iteration": int,           # per-thread counter, 1-based
        "code":      "200" | "Non HTTP response code: ...",
        "ms":        int,           # elapsed (ms)
        "passed":    bool,          # JMeter "success" column
        "error":     str | None,    # failureMessage when not an assertion failure
        "assertions": [             # parsed from failureMessage; empty when passed
            {"name": str, "expected": str, "actual": str, "pass": bool},
            ...
        ],
    }
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from typing import Iterator

# JMeter's default thread-name format is "<ThreadGroupName> <groupIdx>-<threadIdx>".
# We only have one thread group, so groupIdx is always 1; threadIdx is what we
# care about.
_THREAD_NAME_RE = re.compile(r"(\d+)-(\d+)\s*$")


@dataclass
class JtlTailer:
    """Stateful tailer over a single JTL file.

    Usage:
        t = JtlTailer(path)
        for sample in t.read_new():   # call repeatedly as the file grows
            ...
    """

    path: str
    _offset: int = 0
    _leftover: str = ""
    _header: list[str] | None = None
    _seq: int = 0
    _iter_by_thread: dict[int, int] = field(default_factory=dict)

    def read_new(self) -> Iterator[dict]:
        """Yield any completed rows that have appeared since the last call.

        Safe to call when the file doesn't exist yet (yields nothing).
        Safe to call after the file has been deleted; we just stop yielding.
        """
        try:
            with open(self.path, "rb") as f:
                f.seek(self._offset)
                chunk = f.read()
                self._offset = f.tell()
        except FileNotFoundError:
            return

        if not chunk:
            return

        # Decode tolerantly. JMeter writes UTF-8 by default; failureMessage
        # could in theory contain bytes from server bodies, so don't crash.
        text = self._leftover + chunk.decode("utf-8", errors="replace")

        # Hold the trailing partial line (everything after the last newline)
        # until the next poll completes it.
        last_nl = text.rfind("\n")
        if last_nl == -1:
            self._leftover = text
            return

        complete = text[: last_nl + 1]
        self._leftover = text[last_nl + 1 :]

        # csv.reader handles quoted fields with embedded newlines correctly,
        # but we've already cut on \n above. A failureMessage with embedded
        # newlines could be split across polls — for the v1 single-line case
        # this is fine, and even when it does happen csv.reader will treat
        # the partial text as a malformed row rather than crash.
        reader = csv.reader(io.StringIO(complete))
        for row in reader:
            if not row:
                continue
            if self._header is None:
                self._header = row
                continue
            sample = self._row_to_sample(row)
            if sample is not None:
                yield sample

    def _row_to_sample(self, row: list[str]) -> dict | None:
        if self._header is None:
            return None
        # Defensive: if a row has fewer columns than the header (truncated),
        # bail rather than IndexError. Extra columns are fine — JMeter can
        # append timing breakdowns we don't read.
        if len(row) < len(self._header):
            return None

        cols = dict(zip(self._header, row))

        thread_name = cols.get("threadName", "")
        thread_num = _parse_thread_num(thread_name)

        # Increment per-thread iteration counter. When threadNum is unknown
        # (parsing failed), bucket under 0.
        prev = self._iter_by_thread.get(thread_num, 0)
        iteration = prev + 1
        self._iter_by_thread[thread_num] = iteration

        self._seq += 1
        seq = self._seq

        elapsed = _to_int(cols.get("elapsed"), 0)
        success = (cols.get("success", "true").strip().lower() == "true")
        code = cols.get("responseCode", "").strip() or "ERR"
        failure_message = (cols.get("failureMessage") or "").strip()

        assertions, transport_error = _split_failure_message(failure_message, success)

        return {
            "id": f"{seq}-{thread_num}-{iteration}",
            "threadNum": thread_num,
            "iteration": iteration,
            "code": code,
            "ms": elapsed,
            "passed": success,
            "error": transport_error,
            "assertions": assertions,
        }


def _parse_thread_num(thread_name: str) -> int:
    if not thread_name:
        return 0
    m = _THREAD_NAME_RE.search(thread_name)
    if not m:
        return 0
    # The trailing number after the dash is the within-group thread index.
    try:
        return int(m.group(2))
    except ValueError:
        return 0


def _to_int(value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return default


def _split_failure_message(
    msg: str, success: bool
) -> tuple[list[dict], str | None]:
    """Convert JMeter's failureMessage column into the frontend's assertion shape.

    JMeter writes assertion failures into failureMessage as one or more lines
    (sometimes multiple assertions concatenated). When success=true we return
    no assertions and no transport error. When success=false:

      * If the message looks like an assertion failure, we surface it as one
        or more assertion entries with pass=false.
      * If the message looks like a transport-level failure (non-HTTP error,
        connect refused, etc.), we put it in the `error` field and return
        no assertions.
    """
    if success or not msg:
        return [], None

    looks_like_transport = any(
        marker in msg
        for marker in (
            "Non HTTP response code:",
            "java.net.",
            "Connection refused",
            "ConnectException",
            "UnknownHostException",
            "SocketTimeoutException",
            "SSLHandshakeException",
        )
    )
    if looks_like_transport:
        return [], msg

    # Otherwise treat as one or more assertion failures. Lines that look like
    # "<Assertion Name>: <details>" get split; otherwise we treat the whole
    # message as a single assertion entry.
    entries: list[dict] = []
    for raw_line in msg.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        name, _, detail = line.partition(":")
        name = name.strip() or "Assertion"
        detail = detail.strip()
        entries.append(
            {
                "name": name if detail else "Assertion",
                "expected": "pass",
                "actual": detail if detail else line,
                "pass": False,
            }
        )

    if not entries:
        # Defensive fallback: at least one entry so the UI can show *something*.
        entries.append(
            {"name": "Assertion", "expected": "pass", "actual": msg, "pass": False}
        )

    return entries, None
