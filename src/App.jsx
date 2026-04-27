import { useMemo, useRef, useState } from 'react';
import { buildJmx } from './jmx-builder.js';
import { runSimulation, computeStats } from './simulator.js';

const initialState = {
  testPlanName: 'API Load Test',
  threadGroupName: 'Users',
  url: 'https://api.example.com/v1/health',
  threads: 10,
  rampUp: 5,
  loops: 1,
  assertions: {
    responseCode: { enabled: true, value: '200' },
    responseTime: { enabled: false, value: 1000 },
    bodyContains: { enabled: false, value: '' },
  },
};

export default function App() {
  const [form, setForm] = useState(initialState);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [tab, setTab] = useState('preview');

  const update = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateAssertion = (key, patch) => {
    setForm((prev) => ({
      ...prev,
      assertions: {
        ...prev.assertions,
        [key]: { ...prev.assertions[key], ...patch },
      },
    }));
  };

  // Live JMX recomputed on every form change. parseUrl throws on empty/invalid
  // URLs — we surface that as a friendly placeholder rather than crashing.
  const jmx = useMemo(() => {
    try {
      return { ok: true, xml: buildJmx(form) };
    } catch (err) {
      return { ok: false, message: err.message || 'Cannot build JMX' };
    }
  }, [form]);

  const handleDownload = (e) => {
    e.preventDefault();
    setError('');
    setConfirm(false);

    if (!jmx.ok) {
      setError(jmx.message);
      return;
    }

    try {
      const blob = new Blob([jmx.xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filename =
        (form.testPlanName || 'test_plan').trim().replace(/\s+/g, '_') + '.jmx';
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 2500);
    } catch (err) {
      setError(err.message || 'Failed to generate JMX');
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">{'{ }'}</span>
          <span className="brand-name">JMX Test Plan Builder</span>
        </div>
        <p className="tagline">
          Generate Apache JMeter test plans for GET API load tests &mdash; fully
          client-side.
        </p>
      </header>

      <form className="form" onSubmit={handleDownload}>
        <Section number="01" title="Test Plan">
          <div className="grid two">
            <Field
              label="Test Plan Name"
              value={form.testPlanName}
              onChange={(v) => update('testPlanName', v)}
              placeholder="API Load Test"
            />
            <Field
              label="Thread Group Name"
              value={form.threadGroupName}
              onChange={(v) => update('threadGroupName', v)}
              placeholder="Users"
            />
          </div>
        </Section>

        <Section number="02" title="HTTP Request">
          <Field
            label="Target URL"
            value={form.url}
            onChange={(v) => update('url', v)}
            placeholder="https://api.example.com/v1/health?key=abc"
            mono
          />
          <p className="hint">
            Full URL including protocol, host, path, and query string. Method is
            always GET.
          </p>
        </Section>

        <Section number="03" title="Load Configuration">
          <div className="grid three">
            <Field
              label="Threads"
              type="number"
              min={1}
              value={form.threads}
              onChange={(v) => update('threads', v)}
            />
            <Field
              label="Ramp-up (s)"
              type="number"
              min={0}
              value={form.rampUp}
              onChange={(v) => update('rampUp', v)}
            />
            <Field
              label="Loops"
              type="number"
              min={1}
              value={form.loops}
              onChange={(v) => update('loops', v)}
            />
          </div>
        </Section>

        <Section number="04" title="Assertions">
          <AssertionRow
            label="Response Code"
            description="Fail the sample if the response code is not equal to this value."
            enabled={form.assertions.responseCode.enabled}
            onToggle={(enabled) => updateAssertion('responseCode', { enabled })}
          >
            <Field
              label="Expected code"
              value={form.assertions.responseCode.value}
              onChange={(v) => updateAssertion('responseCode', { value: v })}
              placeholder="200"
              mono
            />
          </AssertionRow>

          <AssertionRow
            label="Response Time Threshold"
            description="Fail the sample if the response takes longer than this many milliseconds."
            enabled={form.assertions.responseTime.enabled}
            onToggle={(enabled) => updateAssertion('responseTime', { enabled })}
          >
            <Field
              label="Max duration (ms)"
              type="number"
              min={0}
              value={form.assertions.responseTime.value}
              onChange={(v) => updateAssertion('responseTime', { value: v })}
              placeholder="1000"
              mono
            />
          </AssertionRow>

          <AssertionRow
            label="Response Body Contains"
            description="Fail the sample if the response body does not contain this substring."
            enabled={form.assertions.bodyContains.enabled}
            onToggle={(enabled) => updateAssertion('bodyContains', { enabled })}
          >
            <Field
              label="Substring"
              value={form.assertions.bodyContains.value}
              onChange={(v) => updateAssertion('bodyContains', { value: v })}
              placeholder='"status":"ok"'
              mono
            />
          </AssertionRow>
        </Section>

        <div className="footer-bar">
          <div className="footer-status">
            {error && <span className="status status-error">{error}</span>}
            {confirm && (
              <span className="status status-ok">
                <span className="check">✓</span> generated successfully
              </span>
            )}
          </div>
          <button type="submit" className="primary">
            Download .jmx
          </button>
        </div>
      </form>

      <div className="tabs">
        <div className="tabs-bar" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preview'}
            className={`tab ${tab === 'preview' ? 'tab-active' : ''}`}
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'run'}
            className={`tab ${tab === 'run' ? 'tab-active' : ''}`}
            onClick={() => setTab('run')}
          >
            Run Test
          </button>
        </div>

        <div className="tabs-body">
          {tab === 'preview' ? (
            <PreviewPanel jmx={jmx} />
          ) : (
            <RunPanel form={form} />
          )}
        </div>
      </div>

      <footer className="page-footer">
        <span>Output: JMeter 5.6.3 compatible</span>
        <span className="dot" />
        <span>No data leaves your browser</span>
      </footer>
    </div>
  );
}

function Section({ number, title, children }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="section-num">{number}</span>
        <h2 className="section-title">{title}</h2>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  min,
  mono = false,
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={mono ? 'input mono' : 'input'}
        type={type}
        value={value}
        min={min}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function AssertionRow({ label, description, enabled, onToggle, children }) {
  return (
    <div className={`assertion ${enabled ? 'on' : ''}`}>
      <label className="assertion-head">
        <span
          className={`toggle ${enabled ? 'toggle-on' : ''}`}
          role="switch"
          aria-checked={enabled}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="toggle-track" />
          <span className="toggle-thumb" />
        </span>
        <span className="assertion-text">
          <span className="assertion-label">{label}</span>
          <span className="assertion-desc">{description}</span>
        </span>
      </label>
      {enabled && <div className="assertion-body">{children}</div>}
    </div>
  );
}

/* ============================== Preview Panel ============================ */

function PreviewPanel({ jmx }) {
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    if (!jmx.ok) return null;
    return highlightXml(jmx.xml);
  }, [jmx]);

  const handleCopy = async () => {
    if (!jmx.ok) return;
    try {
      await navigator.clipboard.writeText(jmx.xml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // no-op: clipboard may be unavailable in non-secure contexts
    }
  };

  return (
    <div className="panel preview">
      <div className="panel-head">
        <span className="panel-label">jmeter test plan · live</span>
        <div className="panel-actions">
          {copied && <span className="status status-ok mini">✓ copied</span>}
          <button
            type="button"
            className="ghost"
            onClick={handleCopy}
            disabled={!jmx.ok}
          >
            Copy
          </button>
        </div>
      </div>
      {jmx.ok ? (
        <pre
          className="code-block"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="panel-empty">
          <div className="panel-empty-title">Cannot render preview</div>
          <div className="panel-empty-sub">{jmx.message}</div>
        </div>
      )}
    </div>
  );
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => HTML_ESCAPE[c]);
}

function highlightXml(xml) {
  let out = '';
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      out += escapeHtml(xml.slice(i));
      break;
    }
    if (lt > i) {
      const text = xml.slice(i, lt);
      out += text.trim()
        ? `<span class="xml-text">${escapeHtml(text)}</span>`
        : escapeHtml(text);
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) {
      out += escapeHtml(xml.slice(lt));
      break;
    }
    out += highlightTag(xml.slice(lt, gt + 1));
    i = gt + 1;
  }
  return out;
}

function highlightTag(tag) {
  let inner = tag.slice(1, -1);
  let prefix = '';
  let suffix = '';
  if (inner.startsWith('?') || inner.startsWith('!') || inner.startsWith('/')) {
    prefix = inner[0];
    inner = inner.slice(1);
  }
  if (inner.endsWith('?') || inner.endsWith('/')) {
    suffix = inner[inner.length - 1];
    inner = inner.slice(0, -1);
  }
  const m = inner.match(/^([\w:.-]+)([\s\S]*)$/);
  if (!m) return escapeHtml(tag);
  const name = m[1];
  const rest = m[2];

  const attrs = rest.replace(
    /(\s+)([\w:.-]+)(\s*=\s*)("(?:[^"]|\\.)*"|'(?:[^']|\\.)*')/g,
    (_, ws, n, eq, v) =>
      `${ws}<span class="xml-attr">${escapeHtml(n)}</span><span class="xml-punct">${escapeHtml(eq)}</span><span class="xml-value">${escapeHtml(v)}</span>`
  );

  return (
    `<span class="xml-bracket">&lt;${escapeHtml(prefix)}</span>` +
    `<span class="xml-tag">${escapeHtml(name)}</span>` +
    attrs +
    `<span class="xml-bracket">${escapeHtml(suffix)}&gt;</span>`
  );
}

/* ============================ Run Test Panel ============================= */

function RunPanel({ form }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [runError, setRunError] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const runIdRef = useRef(0);

  const stats = useMemo(() => computeStats(results), [results]);

  const enabledAssertions = useMemo(() => {
    const out = {};
    if (form.assertions.responseCode.enabled) {
      out.responseCode = form.assertions.responseCode.value;
    }
    if (form.assertions.responseTime.enabled) {
      out.maxResponseTime = form.assertions.responseTime.value;
    }
    if (
      form.assertions.bodyContains.enabled &&
      form.assertions.bodyContains.value
    ) {
      out.bodyContains = form.assertions.bodyContains.value;
    }
    return out;
  }, [form.assertions]);

  const handleRun = async () => {
    if (running) return;
    setRunError('');
    setResults([]);
    setExpanded(new Set());
    setProgress({ done: 0, total: 0 });
    setRunning(true);

    const myRunId = ++runIdRef.current;
    const live = [];

    try {
      await runSimulation(
        {
          url: form.url,
          threads: form.threads,
          rampUp: form.rampUp,
          loops: form.loops,
          assertions: enabledAssertions,
        },
        (sample) => {
          if (runIdRef.current !== myRunId) return;
          live.push(sample);
          // Sort by completion order to keep table chronological.
          setResults([...live].sort((a, b) => a.seq - b.seq));
        },
        (p) => {
          if (runIdRef.current !== myRunId) return;
          setProgress(p);
        }
      );
    } catch (err) {
      setRunError(err.message || 'Simulation failed');
    } finally {
      if (runIdRef.current === myRunId) setRunning(false);
    }
  };

  const toggleRow = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="panel run">
      <div className="run-controls">
        <button
          type="button"
          className={running ? 'primary running' : 'primary'}
          onClick={handleRun}
          disabled={running}
        >
          {running ? '■ Stop' : '▶ Run Test'}
        </button>
        <span className="progress">
          {progress.total > 0
            ? `${progress.done} / ${progress.total} requests`
            : `${form.threads * form.loops} requests configured`}
        </span>
        {runError && <span className="status status-error">{runError}</span>}
      </div>

      <p className="hint cors-note">
        Runs use the browser&apos;s fetch &mdash; APIs without CORS headers
        will fail. Open-Meteo, JSONPlaceholder, and most public APIs work.
      </p>

      {stats && <StatsCard stats={stats} />}

      {results.length === 0 ? (
        <EmptyState />
      ) : (
        <ResultsTable
          results={results}
          expanded={expanded}
          onToggle={toggleRow}
        />
      )}
    </div>
  );
}

function StatsCard({ stats }) {
  return (
    <div className="stats">
      <StatTile label="Total" value={stats.total} />
      <StatTile label="Passed" value={stats.passed} tone="ok" />
      <StatTile label="Failed" value={stats.failed} tone="err" />
      <StatTile label="Avg ms" value={stats.avg} />
      <StatTile label="Min ms" value={stats.min} />
      <StatTile label="Max ms" value={stats.max} />
      <StatTile label="p50" value={stats.p50} />
      <StatTile label="p95" value={stats.p95} />
    </div>
  );
}

function StatTile({ label, value, tone }) {
  const cls = tone === 'ok' ? 'tile-ok' : tone === 'err' ? 'tile-err' : '';
  return (
    <div className={`tile ${cls}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-mark">·</div>
      <div className="empty-title">No test runs yet</div>
      <div className="empty-sub">
        Click Run Test to execute against the configured URL.
      </div>
    </div>
  );
}

function ResultsTable({ results, expanded, onToggle }) {
  return (
    <div className="results">
      <div className="results-head">
        <span className="col-num">#</span>
        <span className="col-thread">Thread</span>
        <span className="col-iter">Iter</span>
        <span className="col-status">Status</span>
        <span className="col-time">Time (ms)</span>
        <span className="col-result">Pass/Fail</span>
      </div>
      <div className="results-body">
        {results.map((r, i) => {
          const open = expanded.has(r.id);
          return (
            <div
              key={r.id}
              className={`result-row ${open ? 'open' : ''} ${r.pass ? 'row-pass' : 'row-fail'}`}
            >
              <button
                type="button"
                className="result-main"
                onClick={() => onToggle(r.id)}
                aria-expanded={open}
              >
                <span className="col-num">{i + 1}</span>
                <span className="col-thread">{r.thread}</span>
                <span className="col-iter">{r.iter}</span>
                <span className="col-status">
                  {r.error ? 'ERR' : r.status}
                </span>
                <span className="col-time">{r.timeMs}</span>
                <span className="col-result">
                  {r.pass ? (
                    <span className="pf pf-ok">✓</span>
                  ) : (
                    <span className="pf pf-err">✗</span>
                  )}
                </span>
              </button>
              {open && <ResultDetail sample={r} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultDetail({ sample }) {
  return (
    <div className="result-detail">
      {sample.error && (
        <div className="detail-error">Network error: {sample.error}</div>
      )}

      {sample.assertionResults.length > 0 && (
        <div className="detail-block">
          <div className="detail-label">Assertions</div>
          <ul className="assert-list">
            {sample.assertionResults.map((a, i) => (
              <li
                key={i}
                className={`assert-item ${a.pass ? 'a-ok' : 'a-err'}`}
              >
                <span className="assert-mark">{a.pass ? '✓' : '✗'}</span>
                <span className="assert-name">{a.name}</span>
                <span className="assert-meta">
                  expected <code>{a.expected}</code> · got{' '}
                  <code>{a.actual}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-block">
        <div className="detail-label">Body preview</div>
        <pre className="body-preview">
          {sample.bodyPreview || <em className="dim">(empty)</em>}
        </pre>
      </div>
    </div>
  );
}
