"""Python port of src/jmx-builder.js.

The output is intended to be byte-for-byte identical to the JS version for the
same input config. If you change one of these files, change the other and
re-run scripts/check_jmx_parity.py.
"""

from __future__ import annotations

from typing import Any, Iterable
from urllib.parse import urlsplit

# JMeter ResponseAssertion test_type bitfield (from
# org.apache.jmeter.assertions.ResponseAssertion):
#   1  = MATCH      (regex, full string)
#   2  = CONTAINS   (regex find)
#   4  = NOT        (modifier)
#   8  = EQUALS     (literal equality)
#   16 = SUBSTRING  (literal substring, not regex)
TEST_TYPE_EQUALS = 8
TEST_TYPE_SUBSTRING = 16

SUPPORTED_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
METHODS_WITH_BODY = frozenset({"POST", "PUT", "PATCH"})


def escape_xml(value: Any) -> str:
    """Mirror utils.js#escapeXml: &, <, >, ", ' get replaced in that order."""
    if value is None:
        return ""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def parse_url(raw_url: Any) -> dict:
    """Mirror utils.js#parseUrl. Returns dict with protocol/hostname/port/path.

    Raises ValueError on empty/invalid URLs (the JS version throws Error).
    """
    trimmed = (str(raw_url) if raw_url is not None else "").strip()
    if not trimmed:
        raise ValueError("URL is required")

    try:
        parts = urlsplit(trimmed)
    except ValueError as exc:
        raise ValueError(f"Invalid URL: {trimmed}") from exc

    if not parts.scheme or not parts.hostname:
        raise ValueError(f"Invalid URL: {trimmed}")

    protocol = parts.scheme.lower()
    hostname = parts.hostname or ""
    port = "" if parts.port is None else str(parts.port)
    path = (parts.path or "/")
    if parts.query:
        path = f"{path}?{parts.query}"

    return {
        "protocol": protocol,
        "hostname": hostname,
        "port": port,
        "path": path,
    }


def _normalize_method(method: Any) -> str:
    upper = str(method or "GET").upper()
    return upper if upper in SUPPORTED_METHODS else "GET"


def _normalize_headers(headers: Any) -> list[dict]:
    if not isinstance(headers, list):
        return []
    out: list[dict] = []
    for h in headers:
        if not isinstance(h, dict):
            continue
        name = str(h.get("name") or "").strip()
        value = str(h.get("value") if h.get("value") is not None else "")
        if name:
            out.append({"name": name, "value": value})
    return out


def _to_int_min(value: Any, minimum: int, default: int) -> int:
    """Mirror Math.max(min, parseInt(x, 10) || default)."""
    try:
        n = int(str(value).strip()) if value not in (None, "") else default
    except (TypeError, ValueError):
        n = default
    if n == 0 and minimum > 0:
        # parseInt returns NaN for non-numeric strings → || default. We
        # collapse the NaN/0 cases here the same way.
        n = default
    return max(minimum, n)


def build_jmx(config: dict) -> str:
    """Build a JMeter .jmx XML string from a config dict.

    Mirrors src/jmx-builder.js#buildJmx. See that file for the config schema.
    """
    test_plan_name = config.get("testPlanName")
    thread_group_name = config.get("threadGroupName")
    url = config.get("url")
    threads = config.get("threads")
    ramp_up = config.get("rampUp")
    loops = config.get("loops")
    assertions = config.get("assertions") or {}

    parsed = parse_url(url)

    method = _normalize_method(config.get("method"))
    headers = _normalize_headers(config.get("headers"))
    raw_body = config.get("body")
    has_body = method in METHODS_WITH_BODY and (raw_body if raw_body is not None else "") != ""
    body = str(raw_body) if has_body else ""
    content_type = (config.get("contentType") or "").strip()

    # Auto-attach Content-Type only when sending a body and the user hasn't
    # already declared one (case-insensitive match).
    final_headers = list(headers)
    if has_body and content_type:
        has_ct = any(h["name"].strip().lower() == "content-type" for h in final_headers)
        if not has_ct:
            final_headers.insert(0, {"name": "Content-Type", "value": content_type})

    tp_name = escape_xml(test_plan_name or "Test Plan")
    tg_name = escape_xml(thread_group_name or "Thread Group")
    http_name = escape_xml("HTTP Request")

    num_threads = _to_int_min(threads, 1, 1)
    ramp = _to_int_min(ramp_up, 0, 0)
    loop_count = _to_int_min(loops, 1, 1)

    arguments_xml = (
        _build_raw_body_arguments(body)
        if has_body
        else '            <collectionProp name="Arguments.arguments"/>'
    )

    header_manager_xml = _build_header_manager(final_headers)
    assertion_xml = _build_assertions(assertions)

    # The HTTPSamplerProxy hashTree contains: header manager (if any) followed
    # by assertion blocks. JMeter doesn't care about ordering between them but
    # header managers conventionally appear first.
    sampler_children = "\n".join(part for part in (header_manager_xml, assertion_xml) if part)

    post_body_raw_line = (
        '\n          <boolProp name="HTTPSampler.postBodyRaw">true</boolProp>' if has_body else ""
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n'
        '  <hashTree>\n'
        f'    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="{tp_name}" enabled="true">\n'
        '      <stringProp name="TestPlan.comments"></stringProp>\n'
        '      <boolProp name="TestPlan.functional_mode">false</boolProp>\n'
        '      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>\n'
        '      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>\n'
        '      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">\n'
        '        <collectionProp name="Arguments.arguments"/>\n'
        '      </elementProp>\n'
        '      <stringProp name="TestPlan.user_define_classpath"></stringProp>\n'
        '    </TestPlan>\n'
        '    <hashTree>\n'
        f'      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="{tg_name}" enabled="true">\n'
        '        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>\n'
        '        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">\n'
        '          <boolProp name="LoopController.continue_forever">false</boolProp>\n'
        f'          <stringProp name="LoopController.loops">{loop_count}</stringProp>\n'
        '        </elementProp>\n'
        f'        <stringProp name="ThreadGroup.num_threads">{num_threads}</stringProp>\n'
        f'        <stringProp name="ThreadGroup.ramp_time">{ramp}</stringProp>\n'
        '        <boolProp name="ThreadGroup.scheduler">false</boolProp>\n'
        '        <stringProp name="ThreadGroup.duration"></stringProp>\n'
        '        <stringProp name="ThreadGroup.delay"></stringProp>\n'
        '        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>\n'
        '      </ThreadGroup>\n'
        '      <hashTree>\n'
        f'        <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="{http_name}" enabled="true">\n'
        f'          <stringProp name="HTTPSampler.domain">{escape_xml(parsed["hostname"])}</stringProp>\n'
        f'          <stringProp name="HTTPSampler.port">{escape_xml(parsed["port"])}</stringProp>\n'
        f'          <stringProp name="HTTPSampler.protocol">{escape_xml(parsed["protocol"])}</stringProp>\n'
        '          <stringProp name="HTTPSampler.contentEncoding"></stringProp>\n'
        f'          <stringProp name="HTTPSampler.path">{escape_xml(parsed["path"])}</stringProp>\n'
        f'          <stringProp name="HTTPSampler.method">{method}</stringProp>\n'
        '          <boolProp name="HTTPSampler.follow_redirects">true</boolProp>\n'
        '          <boolProp name="HTTPSampler.auto_redirects">false</boolProp>\n'
        '          <boolProp name="HTTPSampler.use_keepalive">true</boolProp>\n'
        '          <boolProp name="HTTPSampler.DO_MULTIPART_POST">false</boolProp>\n'
        '          <stringProp name="HTTPSampler.embedded_url_re"></stringProp>\n'
        '          <stringProp name="HTTPSampler.connect_timeout"></stringProp>\n'
        f'          <stringProp name="HTTPSampler.response_timeout"></stringProp>{post_body_raw_line}\n'
        '          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">\n'
        f'{arguments_xml}\n'
        '          </elementProp>\n'
        '        </HTTPSamplerProxy>\n'
        '        <hashTree>\n'
        f'{sampler_children}\n'
        '        </hashTree>\n'
        '      </hashTree>\n'
        '    </hashTree>\n'
        '  </hashTree>\n'
        '</jmeterTestPlan>\n'
    )


def _build_raw_body_arguments(body: str) -> str:
    # postBodyRaw mode: a single HTTPArgument whose value is the entire body.
    # The empty Argument.metadata "=" and always_encode=false are what JMeter's
    # raw-body GUI persists.
    return (
        '            <collectionProp name="Arguments.arguments">\n'
        '              <elementProp name="" elementType="HTTPArgument">\n'
        '                <boolProp name="HTTPArgument.always_encode">false</boolProp>\n'
        f'                <stringProp name="Argument.value">{escape_xml(body)}</stringProp>\n'
        '                <stringProp name="Argument.metadata">=</stringProp>\n'
        '              </elementProp>\n'
        '            </collectionProp>'
    )


def _build_header_manager(headers: Iterable[dict]) -> str:
    headers = list(headers)
    if not headers:
        return ""

    rows = "\n".join(
        (
            f'            <elementProp name="{escape_xml(h["name"])}" elementType="Header">\n'
            f'              <stringProp name="Header.name">{escape_xml(h["name"])}</stringProp>\n'
            f'              <stringProp name="Header.value">{escape_xml(h["value"])}</stringProp>\n'
            f'            </elementProp>'
        )
        for h in headers
    )

    return (
        '          <HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager" enabled="true">\n'
        '            <collectionProp name="HeaderManager.headers">\n'
        f'{rows}\n'
        '            </collectionProp>\n'
        '          </HeaderManager>\n'
        '          <hashTree/>'
    )


def _build_assertions(assertions: dict) -> str:
    blocks: list[str] = []

    rc = assertions.get("responseCode") if isinstance(assertions, dict) else None
    if isinstance(rc, dict) and rc.get("enabled"):
        blocks.append(
            _build_response_assertion(
                testname="Response Code Assertion",
                test_field="Assertion.response_code",
                test_type=TEST_TYPE_EQUALS,
                value=str(rc.get("value") if rc.get("value") is not None else "200"),
            )
        )

    rt = assertions.get("responseTime") if isinstance(assertions, dict) else None
    if isinstance(rt, dict) and rt.get("enabled"):
        try:
            ms = int(str(rt.get("value")).strip())
        except (TypeError, ValueError, AttributeError):
            ms = 0
        blocks.append(_build_duration_assertion(max(0, ms)))

    bc = assertions.get("bodyContains") if isinstance(assertions, dict) else None
    if isinstance(bc, dict) and bc.get("enabled"):
        blocks.append(
            _build_response_assertion(
                testname="Body Contains Assertion",
                test_field="Assertion.response_data",
                test_type=TEST_TYPE_SUBSTRING,
                value=str(bc.get("value") if bc.get("value") is not None else ""),
            )
        )

    return "\n".join(blocks)


def _build_response_assertion(*, testname: str, test_field: str, test_type: int, value: str) -> str:
    # The "Asserion.test_strings" typo is intentional — JMeter persists this
    # misspelled key in serialized test plans and rejects the corrected form.
    return (
        f'          <ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="{escape_xml(testname)}" enabled="true">\n'
        '            <collectionProp name="Asserion.test_strings">\n'
        f'              <stringProp name="jmx_builder_value">{escape_xml(value)}</stringProp>\n'
        '            </collectionProp>\n'
        '            <stringProp name="Assertion.custom_message"></stringProp>\n'
        f'            <stringProp name="Assertion.test_field">{test_field}</stringProp>\n'
        '            <boolProp name="Assertion.assume_success">false</boolProp>\n'
        f'            <intProp name="Assertion.test_type">{test_type}</intProp>\n'
        '          </ResponseAssertion>\n'
        '          <hashTree/>'
    )


def _build_duration_assertion(ms: int) -> str:
    return (
        '          <DurationAssertion guiclass="DurationAssertionGui" testclass="DurationAssertion" testname="Response Time Assertion" enabled="true">\n'
        f'            <stringProp name="DurationAssertion.duration">{ms}</stringProp>\n'
        '          </DurationAssertion>\n'
        '          <hashTree/>'
    )
