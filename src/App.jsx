import { useEffect, useMemo, useRef, useState } from 'react';
import { buildJmx } from './jmx-builder.js';
import RunPanel from './run-panel.jsx';
import {
  AlertIcon,
  BraceIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  GithubIcon,
  LockIcon,
  PlusIcon,
  SendIcon,
  SparkleIcon,
  TrashIcon,
} from './icons.jsx';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

const CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
];

const DEFAULT_RESPONSE_CODES = {
  GET: '200',
  POST: '201',
  PUT: '200',
  PATCH: '200',
  DELETE: '204',
};

const BODY_PLACEHOLDERS = {
  'application/json': '{ "key": "value" }',
  'application/x-www-form-urlencoded': 'key1=value1&key2=value2',
  'text/plain': 'raw request body',
};

const HEADER_PRESETS = ['Authorization', 'Accept', 'User-Agent', 'X-API-Key'];

// Mirrors the caps in the Flask backend.
const SERVER_THREADS_MAX = 5000;
const SERVER_RAMPUP_MAX = 3600;
const SERVER_LOOPS_MAX = 10000;
const BROWSER_THREADS_MAX = 200;
const BROWSER_THREADS_SOFT_WARN = 25;

const TABS = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'params', label: 'Params' },
  { id: 'assertions', label: 'Assertions' },
  { id: 'load', label: 'Load Config' },
  { id: 'preview', label: 'Preview' },
  { id: 'run', label: 'Run Test' },
];

const initialState = {
  testPlanName: 'API Load Test',
  threadGroupName: 'Users',
  url: 'https://api.example.com/v1/health',
  method: 'GET',
  contentType: 'application/json',
  body: '',
  headers: [],
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
  const [downloadError, setDownloadError] = useState('');
  const [downloadConfirm, setDownloadConfirm] = useState(false);
  const initialTab = METHODS_WITH_BODY.has(initialState.method) ? 'body' : 'headers';
  const [tab, setTab] = useState(initialTab);
  const [runMode, setRunMode] = useState('browser');
  const [runToken, setRunToken] = useState(0);
  // Tracks whether the user has manually edited the expected response code.
  // Until they do, switching methods updates the field to that method's
  // conventional success code (200/201/204).
  const responseCodeDirtyRef = useRef(false);

  const update = (key, value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const updateMethod = (nextMethod) => {
    setForm((prev) => {
      const next = { ...prev, method: nextMethod };
      if (!responseCodeDirtyRef.current) {
        next.assertions = {
          ...prev.assertions,
          responseCode: {
            ...prev.assertions.responseCode,
            value: DEFAULT_RESPONSE_CODES[nextMethod] ?? '200',
          },
        };
      }
      return next;
    });
  };

  const updateAssertion = (key, patch) => {
    if (key === 'responseCode' && Object.prototype.hasOwnProperty.call(patch, 'value')) {
      responseCodeDirtyRef.current = true;
    }
    setForm((prev) => ({
      ...prev,
      assertions: {
        ...prev.assertions,
        [key]: { ...prev.assertions[key], ...patch },
      },
    }));
  };

  const updateHeaders = (nextHeaders) =>
    setForm((prev) => ({ ...prev, headers: nextHeaders }));

  // Live JMX recomputed on every form change. parseUrl throws on empty/invalid
  // URLs — we surface that as a friendly placeholder rather than crashing.
  const jmx = useMemo(() => {
    try {
      return { ok: true, xml: buildJmx(form) };
    } catch (err) {
      return { ok: false, message: err.message || 'Cannot build JMX' };
    }
  }, [form]);

  const filename = useMemo(() => {
    const base = (form.testPlanName || 'test_plan').trim().replace(/\s+/g, '_');
    return `${base || 'test_plan'}.jmx`;
  }, [form.testPlanName]);

  const headerCount = form.headers.length;
  const enabledAssertionsCount = useMemo(() => {
    let n = 0;
    if (form.assertions.responseCode.enabled) n++;
    if (form.assertions.responseTime.enabled) n++;
    if (form.assertions.bodyContains.enabled) n++;
    return n;
  }, [form.assertions]);

  const showBody = METHODS_WITH_BODY.has(form.method);

  // Auto-switch off the Body tab when the method changes to one that doesn't
  // support a body — leaving the user staring at a disabled tab is jarring.
  useEffect(() => {
    if (tab === 'body' && !showBody) setTab('headers');
  }, [tab, showBody]);

  const handleDownload = () => {
    setDownloadError('');
    setDownloadConfirm(false);

    if (!jmx.ok) {
      setDownloadError(jmx.message);
      return;
    }

    try {
      const blob = new Blob([jmx.xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDownloadConfirm(true);
      window.setTimeout(() => setDownloadConfirm(false), 2500);
    } catch (err) {
      setDownloadError(err.message || 'Failed to generate JMX');
    }
  };

  const handleSend = () => {
    setTab('run');
    setRunToken((t) => t + 1);
  };

  return (
    <div className="app">
      <HeaderBar onDownload={handleDownload} />
      <Toaster downloadError={downloadError} downloadConfirm={downloadConfirm} />

      <UrlBar
        method={form.method}
        url={form.url}
        onMethodChange={updateMethod}
        onUrlChange={(v) => update('url', v)}
        onSend={handleSend}
      />

      <TabBar
        tab={tab}
        onTabChange={setTab}
        showBody={showBody}
        method={form.method}
        headerCount={headerCount}
        assertionCount={enabledAssertionsCount}
      />

      <main className="tab-content">
        <Pane active={tab === 'body'}>
          <BodyPanel
            method={form.method}
            contentType={form.contentType}
            body={form.body}
            showBody={showBody}
            onContentTypeChange={(v) => update('contentType', v)}
            onBodyChange={(v) => update('body', v)}
          />
        </Pane>

        <Pane active={tab === 'headers'}>
          <HeadersPanel headers={form.headers} onChange={updateHeaders} />
        </Pane>

        <Pane active={tab === 'params'}>
          <ParamsPanel />
        </Pane>

        <Pane active={tab === 'assertions'}>
          <AssertionsPanel
            assertions={form.assertions}
            onUpdate={updateAssertion}
          />
        </Pane>

        <Pane active={tab === 'load'}>
          <LoadConfigPanel
            testPlanName={form.testPlanName}
            threadGroupName={form.threadGroupName}
            threads={form.threads}
            rampUp={form.rampUp}
            loops={form.loops}
            runMode={runMode}
            onUpdate={update}
          />
        </Pane>

        <Pane active={tab === 'preview'}>
          <PreviewPanel jmx={jmx} filename={filename} onDownload={handleDownload} />
        </Pane>

        <Pane active={tab === 'run'} keepMounted>
          <RunPanel
            form={form}
            runMode={runMode}
            setRunMode={setRunMode}
            runToken={runToken}
          />
        </Pane>
      </main>
    </div>
  );
}

/* ============================== Layout shell ============================= */

function HeaderBar({ onDownload }) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo" aria-hidden="true">
          <BraceIcon size={18} />
        </span>
        <span className="topbar-title">JMX Builder</span>
      </div>
      <div className="topbar-spacer" />
      <button
        type="button"
        className="btn btn-primary btn-with-icon"
        onClick={onDownload}
      >
        <DownloadIcon />
        Download .jmx
      </button>
      <a
        href="https://github.com"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-icon-only"
        aria-label="View source on GitHub"
        title="GitHub"
      >
        <GithubIcon size={18} />
      </a>
    </header>
  );
}

function Toaster({ downloadError, downloadConfirm }) {
  if (!downloadError && !downloadConfirm) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {downloadError && (
        <div className="toast toast-error">
          <AlertIcon /> {downloadError}
        </div>
      )}
      {downloadConfirm && (
        <div className="toast toast-success">
          <span className="toast-check">✓</span> {`${downloadConfirm === true ? 'JMX file downloaded' : downloadConfirm}`}
        </div>
      )}
    </div>
  );
}

/* ================================ URL bar ================================ */

function UrlBar({ method, url, onMethodChange, onUrlChange, onSend }) {
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="urlbar-wrap">
      <div className="urlbar">
        <MethodPicker value={method} onChange={onMethodChange} />
        <input
          className="urlbar-input mono"
          type="text"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter request URL"
          spellCheck={false}
          aria-label="Request URL"
        />
        <button
          type="button"
          className="btn btn-primary urlbar-send btn-with-icon"
          onClick={onSend}
        >
          <SendIcon />
          Send
        </button>
      </div>
    </div>
  );
}

function MethodPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="method-picker" ref={ref}>
      <button
        type="button"
        className="method-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MethodPill method={value} />
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="method-menu" role="listbox" aria-label="HTTP method">
          {HTTP_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === value}
              className={`method-menu-item ${m === value ? 'on' : ''}`}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              <MethodPill method={m} />
              {m === value && <span className="method-menu-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MethodPill({ method }) {
  return (
    <span className={`method-pill method-${method.toLowerCase()}`}>
      {method}
    </span>
  );
}

/* ================================ Tabs =================================== */

function TabBar({ tab, onTabChange, showBody, method, headerCount, assertionCount }) {
  return (
    <nav className="tabbar" role="tablist">
      {TABS.map((t) => {
        const disabled = t.id === 'body' && !showBody;
        const count =
          t.id === 'headers' && headerCount > 0
            ? headerCount
            : t.id === 'assertions' && assertionCount > 0
            ? assertionCount
            : null;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={disabled}
            title={
              disabled ? `Body not supported for ${method}` : undefined
            }
            className={`tab ${tab === t.id ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
            onClick={() => !disabled && onTabChange(t.id)}
          >
            {disabled && (
              <span className="tab-lock" aria-hidden="true">
                <LockIcon size={11} />
              </span>
            )}
            <span className="tab-label">{t.label}</span>
            {count !== null && <span className="tab-count">({count})</span>}
          </button>
        );
      })}
    </nav>
  );
}

function Pane({ active, keepMounted = false, children }) {
  // Run tab uses keepMounted so an in-flight run doesn't lose its state when
  // the user clicks over to inspect the Preview tab. Other panes mount on
  // demand — their state lives in App, so mounting is cheap.
  if (!active && !keepMounted) return null;
  return (
    <div className={`tab-pane ${active ? 'tab-pane-active' : 'tab-pane-hidden'}`}>
      {children}
    </div>
  );
}

/* ============================== Body Panel =============================== */

function BodyPanel({
  method,
  contentType,
  body,
  showBody,
  onContentTypeChange,
  onBodyChange,
}) {
  const [jsonError, setJsonError] = useState('');
  const [view, setView] = useState('raw');

  if (!showBody) {
    return (
      <div className="empty-card">
        <LockIcon size={20} />
        <div className="empty-card-title">Body not supported for {method}</div>
        <div className="empty-card-sub">
          {method} requests have no body — only the URL and headers are sent.
          Switch to POST, PUT, or PATCH to add a request body.
        </div>
      </div>
    );
  }

  const handleBlur = () => {
    if (contentType !== 'application/json') {
      setJsonError('');
      return;
    }
    if (!body || !body.trim()) {
      setJsonError('');
      return;
    }
    try {
      JSON.parse(body);
      setJsonError('');
    } catch (err) {
      setJsonError(err.message || 'Invalid JSON');
    }
  };

  const handleBeautify = () => {
    if (contentType !== 'application/json' || !body || !body.trim()) return;
    try {
      const parsed = JSON.parse(body);
      onBodyChange(JSON.stringify(parsed, null, 2));
      setJsonError('');
    } catch (err) {
      setJsonError(err.message || 'Invalid JSON');
    }
  };

  return (
    <div className="panel-stack">
      <div className="panel-row">
        <label className="inline-label">
          <span className="inline-label-text">Content-Type</span>
          <NativeSelect
            value={contentType}
            onChange={(v) => {
              onContentTypeChange(v);
              if (v !== 'application/json') setJsonError('');
            }}
            options={CONTENT_TYPES}
          />
        </label>
        <div className="panel-row-spacer" />
        <div className="seg-toggle seg-toggle-sm">
          <button
            type="button"
            className={`seg-toggle-btn ${view === 'raw' ? 'on' : ''}`}
            onClick={() => setView('raw')}
          >
            Raw
          </button>
          <button
            type="button"
            className={`seg-toggle-btn ${view === 'preview' ? 'on' : ''}`}
            onClick={() => setView('preview')}
          >
            Preview
          </button>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-with-icon btn-sm"
          onClick={handleBeautify}
          disabled={contentType !== 'application/json'}
          title={
            contentType === 'application/json'
              ? 'Pretty-print JSON'
              : 'Beautify is only available for application/json'
          }
        >
          <SparkleIcon /> Beautify
        </button>
      </div>

      {view === 'raw' ? (
        <textarea
          className={`code-input mono ${jsonError ? 'invalid' : ''}`}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          onBlur={handleBlur}
          placeholder={BODY_PLACEHOLDERS[contentType] || ''}
          rows={14}
          spellCheck={false}
          aria-label="Request body"
        />
      ) : (
        <pre className="code-input mono code-input-readonly">
          {body || (
            <span className="dim">No body — switch to Raw to start typing.</span>
          )}
        </pre>
      )}

      {jsonError && (
        <div className="inline-error">
          <AlertIcon /> Invalid JSON: {jsonError}
        </div>
      )}
    </div>
  );
}

/* ============================ Headers Panel ============================== */

function HeadersPanel({ headers, onChange }) {
  const addHeader = (name = '') => onChange([...headers, { name, value: '' }]);
  const updateRow = (i, patch) =>
    onChange(headers.map((h, idx) => (idx === i ? { ...h, ...patch } : h)));
  const removeRow = (i) => onChange(headers.filter((_, idx) => idx !== i));

  return (
    <div className="panel-stack">
      <div className="panel-row">
        <div className="preset-chips">
          <span className="muted-label">Presets</span>
          {HEADER_PRESETS.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              onClick={() => addHeader(name)}
            >
              <PlusIcon size={11} /> {name}
            </button>
          ))}
        </div>
        <div className="panel-row-spacer" />
        <button
          type="button"
          className="btn btn-secondary btn-with-icon btn-sm"
          onClick={() => addHeader('')}
        >
          <PlusIcon /> Add header
        </button>
      </div>

      {headers.length === 0 ? (
        <div className="kv-empty">
          No headers set. Click <strong>Add header</strong> to define one, or
          pick a preset above.
        </div>
      ) : (
        <div className="kv-table" role="table">
          <div className="kv-row kv-head" role="row">
            <span>Name</span>
            <span>Value</span>
            <span aria-hidden="true" />
          </div>
          {headers.map((h, i) => (
            <div className="kv-row" key={i} role="row">
              <input
                className="input mono"
                type="text"
                value={h.name}
                onChange={(e) => updateRow(i, { name: e.target.value })}
                placeholder="Header-Name"
                aria-label={`Header ${i + 1} name`}
              />
              <input
                className="input mono"
                type="text"
                value={h.value}
                onChange={(e) => updateRow(i, { value: e.target.value })}
                placeholder="value"
                aria-label={`Header ${i + 1} value`}
              />
              <button
                type="button"
                className="btn btn-icon-only btn-destructive"
                onClick={() => removeRow(i)}
                aria-label={`Remove header ${i + 1}`}
                title="Remove header"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =============================== Params Panel ============================ */

function ParamsPanel() {
  return (
    <div className="empty-card">
      <div className="empty-card-icon" aria-hidden="true">?=</div>
      <div className="empty-card-title">Query params editor coming soon</div>
      <div className="empty-card-sub">
        For now, include params directly in the URL — e.g.{' '}
        <code>?key=value&amp;other=1</code>.
      </div>
    </div>
  );
}

/* ============================ Assertions Panel =========================== */

function AssertionsPanel({ assertions, onUpdate }) {
  return (
    <div className="panel-stack">
      <p className="panel-intro">
        Assertions run on every sample. Failed assertions mark the sample as
        failed in the run results.
      </p>

      <AssertionRow
        enabled={assertions.responseCode.enabled}
        onToggle={(enabled) => onUpdate('responseCode', { enabled })}
        label="Response code equals"
      >
        <input
          className="input mono input-sm"
          value={assertions.responseCode.value}
          onChange={(e) => onUpdate('responseCode', { value: e.target.value })}
          placeholder="200"
          style={{ width: 100 }}
          aria-label="Expected response code"
        />
      </AssertionRow>

      <AssertionRow
        enabled={assertions.responseTime.enabled}
        onToggle={(enabled) => onUpdate('responseTime', { enabled })}
        label="Response time under"
        suffix="ms"
      >
        <input
          className="input mono input-sm"
          type="number"
          min={0}
          value={assertions.responseTime.value}
          onChange={(e) => onUpdate('responseTime', { value: e.target.value })}
          placeholder="2000"
          style={{ width: 110 }}
          aria-label="Maximum response time (ms)"
        />
      </AssertionRow>

      <AssertionRow
        enabled={assertions.bodyContains.enabled}
        onToggle={(enabled) => onUpdate('bodyContains', { enabled })}
        label="Response body contains"
      >
        <input
          className="input mono input-sm"
          value={assertions.bodyContains.value}
          onChange={(e) => onUpdate('bodyContains', { value: e.target.value })}
          placeholder='"status":"ok"'
          style={{ flex: 1, minWidth: 200 }}
          aria-label="Substring to match"
        />
      </AssertionRow>
    </div>
  );
}

function AssertionRow({ enabled, onToggle, label, suffix, children }) {
  return (
    <label className={`assert-row ${enabled ? 'on' : ''}`}>
      <input
        type="checkbox"
        className="check"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className="check-mark" aria-hidden="true" />
      <span className="assert-row-label">{label}</span>
      <span className="assert-row-input">{children}</span>
      {suffix && <span className="assert-row-suffix">{suffix}</span>}
    </label>
  );
}

/* =========================== Load Config Panel =========================== */

function LoadConfigPanel({
  testPlanName,
  threadGroupName,
  threads,
  rampUp,
  loops,
  runMode,
  onUpdate,
}) {
  const t = parseInt(threads, 10) || 0;
  const l = parseInt(loops, 10) || 0;
  const r = parseInt(rampUp, 10) || 0;
  const total = t * l;

  const browserWarn =
    runMode === 'browser' && t > BROWSER_THREADS_SOFT_WARN
      ? `Browser concurrency is limited — ${t} threads may saturate the browser. Switch to Server mode for higher loads.`
      : '';

  return (
    <div className="panel-stack">
      <div className="grid grid-2">
        <LabeledField label="Test plan name">
          <input
            className="input"
            value={testPlanName}
            onChange={(e) => onUpdate('testPlanName', e.target.value)}
            placeholder="API Load Test"
          />
        </LabeledField>
        <LabeledField label="Thread group name">
          <input
            className="input"
            value={threadGroupName}
            onChange={(e) => onUpdate('threadGroupName', e.target.value)}
            placeholder="Users"
          />
        </LabeledField>
      </div>

      <div className="grid grid-3">
        <LabeledField label="Threads" hint="Concurrent virtual users">
          <input
            className="input input-num"
            type="number"
            min={1}
            max={runMode === 'server' ? SERVER_THREADS_MAX : BROWSER_THREADS_MAX}
            value={threads}
            onChange={(e) => onUpdate('threads', e.target.value)}
          />
        </LabeledField>
        <LabeledField label="Ramp-up" hint="Seconds to start all threads">
          <input
            className="input input-num"
            type="number"
            min={0}
            max={SERVER_RAMPUP_MAX}
            value={rampUp}
            onChange={(e) => onUpdate('rampUp', e.target.value)}
          />
        </LabeledField>
        <LabeledField label="Loops" hint="Requests per thread">
          <input
            className="input input-num"
            type="number"
            min={1}
            max={SERVER_LOOPS_MAX}
            value={loops}
            onChange={(e) => onUpdate('loops', e.target.value)}
          />
        </LabeledField>
      </div>

      <div className="load-summary">
        <strong>{t.toLocaleString()}</strong> threads
        <span className="dim"> × </span>
        <strong>{l.toLocaleString()}</strong> loops
        <span className="dim"> = </span>
        <strong>{total.toLocaleString()}</strong> total requests
        <span className="dim"> · {r}s ramp-up</span>
      </div>

      {browserWarn && (
        <div className="inline-warn">
          <AlertIcon /> {browserWarn}
        </div>
      )}
    </div>
  );
}

function LabeledField({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function NativeSelect({ value, onChange, options }) {
  return (
    <div className="select-wrap">
      <select
        className="input select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <span className="select-caret" aria-hidden="true">
        <ChevronDownIcon size={12} />
      </span>
    </div>
  );
}

/* ============================== Preview Panel ============================ */

function PreviewPanel({ jmx, filename, onDownload }) {
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => {
    if (!jmx.ok) return [];
    return jmx.xml.split('\n').map((line) => highlightXml(line));
  }, [jmx]);

  const handleCopy = async () => {
    if (!jmx.ok) return;
    try {
      await navigator.clipboard.writeText(jmx.xml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable in non-secure contexts; silently no-op.
    }
  };

  return (
    <div className="panel-stack">
      <div className="preview-head">
        <span className="preview-filename mono">{filename}</span>
        <div className="preview-head-actions">
          {copied && <span className="muted-label muted-label-ok">Copied</span>}
          <button
            type="button"
            className="btn btn-ghost btn-with-icon btn-sm"
            onClick={handleCopy}
            disabled={!jmx.ok}
          >
            <CopyIcon /> Copy
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-with-icon btn-sm"
            onClick={onDownload}
            disabled={!jmx.ok}
          >
            <DownloadIcon /> Download
          </button>
        </div>
      </div>

      {jmx.ok ? (
        <div className="code-block">
          {lines.map((html, i) => (
            <div className="code-line" key={i}>
              <span className="code-line-num">{i + 1}</span>
              <span
                className="code-line-content mono"
                dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-card">
          <AlertIcon size={20} />
          <div className="empty-card-title">Cannot render preview</div>
          <div className="empty-card-sub">{jmx.message}</div>
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
