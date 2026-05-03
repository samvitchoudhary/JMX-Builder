"""Verify the Python JMX builder produces the same output as the JS one.

Runs scripts/check_jmx_parity.mjs to capture the JS output for several configs,
then runs the Python builder against the same configs and diffs the result.
Exits 0 on success, 1 with a unified diff on mismatch.
"""

from __future__ import annotations

import difflib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from jmx_builder import build_jmx  # noqa: E402

CONFIGS = [
    {
        "testPlanName": "Minimal GET",
        "threadGroupName": "Workers",
        "url": "https://api.example.com/v1/health",
        "method": "GET",
        "threads": 5,
        "rampUp": 2,
        "loops": 3,
        "assertions": {
            "responseCode": {"enabled": False},
            "responseTime": {"enabled": False},
            "bodyContains": {"enabled": False},
        },
    },
    {
        "testPlanName": "GET with assertions & headers",
        "threadGroupName": "Threads",
        "url": "https://api.open-meteo.com/v1/forecast?latitude=38.99&longitude=-76.94&current=temperature_2m",
        "method": "GET",
        "headers": [
            {"name": "Accept", "value": "application/json"},
            {"name": "User-Agent", "value": "jmx-test/0.1 <hi>"},
        ],
        "threads": 10,
        "rampUp": 5,
        "loops": 1,
        "assertions": {
            "responseCode": {"enabled": True, "value": "200"},
            "responseTime": {"enabled": True, "value": 1500},
            "bodyContains": {"enabled": True, "value": "temperature_2m"},
        },
    },
    {
        "testPlanName": "POST JSON",
        "threadGroupName": "Posters",
        "url": "https://jsonplaceholder.typicode.com/posts",
        "method": "POST",
        "contentType": "application/json",
        "body": '{"title":"a&b","body":"<p>hi</p>","userId":1}',
        "headers": [{"name": "Authorization", "value": "Bearer xyz"}],
        "threads": 3,
        "rampUp": 1,
        "loops": 2,
        "assertions": {
            "responseCode": {"enabled": True, "value": "201"},
            "responseTime": {"enabled": False},
            "bodyContains": {"enabled": True, "value": '"id"'},
        },
    },
    {
        "testPlanName": "PUT user-supplied content-type",
        "threadGroupName": "Putters",
        "url": "http://example.com:8080/api/things/1?x=1&y=2",
        "method": "PUT",
        "contentType": "application/json",
        "body": '{"id":1}',
        "headers": [{"name": "content-type", "value": "application/vnd.api+json"}],
        "threads": 1,
        "rampUp": 0,
        "loops": 1,
        "assertions": {
            "responseCode": {"enabled": True, "value": "200"},
            "responseTime": {"enabled": False},
            "bodyContains": {"enabled": False},
        },
    },
    {
        "testPlanName": "DELETE",
        "threadGroupName": "Deleters",
        "url": "https://api.example.com/items/42",
        "method": "DELETE",
        "body": "should be ignored",
        "threads": 2,
        "rampUp": 1,
        "loops": 1,
        "assertions": {
            "responseCode": {"enabled": True, "value": "204"},
            "responseTime": {"enabled": False},
            "bodyContains": {"enabled": False},
        },
    },
    {
        "testPlanName": "Names with <special> & \"chars\" 'too'",
        "threadGroupName": "TG <1>",
        "url": "https://api.example.com/v1/echo",
        "method": "PATCH",
        "contentType": "text/plain",
        "body": "<root attr=\"v\">&amp;'</root>",
        "headers": [
            {"name": "X-Weird-Name", "value": "<v \"1\" & v's>"},
            {"name": "   trimmed   ", "value": "ok"},
        ],
        "threads": 1,
        "rampUp": 0,
        "loops": 1,
        "assertions": {
            "responseCode": {"enabled": True, "value": "200"},
            "responseTime": {"enabled": True, "value": 500},
            "bodyContains": {"enabled": True, "value": "<root attr=\"v\">&amp;'</root>"},
        },
    },
]


def js_output() -> list[str]:
    proc = subprocess.run(
        ["node", str(ROOT / "scripts" / "check_jmx_parity.mjs")],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    )
    chunks = proc.stdout.split("===CONFIG ")
    if chunks[0] == "":
        chunks = chunks[1:]
    out = []
    for c in chunks:
        # Strip the "<i>===\n" prefix
        nl = c.index("\n")
        out.append(c[nl + 1 :])
    return out


def main() -> int:
    js_chunks = js_output()
    if len(js_chunks) != len(CONFIGS):
        print(f"Expected {len(CONFIGS)} JS chunks, got {len(js_chunks)}", file=sys.stderr)
        return 2

    failures = 0
    for i, (cfg, js_xml) in enumerate(zip(CONFIGS, js_chunks)):
        py_xml = build_jmx(cfg)
        if py_xml == js_xml:
            print(f"[{i}] {cfg['testPlanName']}: OK ({len(py_xml)} bytes)")
            continue
        failures += 1
        print(f"[{i}] {cfg['testPlanName']}: MISMATCH", file=sys.stderr)
        diff = difflib.unified_diff(
            js_xml.splitlines(keepends=True),
            py_xml.splitlines(keepends=True),
            fromfile="js",
            tofile="py",
        )
        sys.stderr.writelines(diff)
        sys.stderr.write("\n")

    if failures:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
