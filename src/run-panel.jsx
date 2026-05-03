import { useEffect, useMemo, useRef, useState } from 'react';
import { runSimulation, computeStats } from './simulator.js';
import { runOnServer } from './server-runner.js';
import {
  CheckIcon,
  PaperAirplaneIcon,
  PlayIcon,
  ServerIcon,
  StopIcon,
  XIcon,
} from './icons.jsx';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

// Mirrors the caps in App.jsx and the Flask backend.
const SERVER_THREADS_MAX = 5000;
const SERVER_RAMPUP_MAX = 3600;
const SERVER_LOOPS_MAX = 10000;
const BROWSER_THREADS_MAX = 200;

/**
 * Run Test panel. Owns its own run lifecycle (browser simulator or server SSE),
 * watches `runToken` so the URL bar's Send button can trigger a run remotely.
 */
export default function RunPanel({ form, runMode, setRunMode, runToken }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]);
  const [runError, setRunError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());

  const runIdRef = useRef(0);
  const browserAbortRef = useRef(null);
  const serverCtrlRef = useRef(null);
  // Latest form/runMode captured each render so the run trigger sees fresh
  // values (the trigger is fired from a useEffect that only sees stale
  // closure-captured props otherwise).
  const formRef = useRef(form);
  const runModeRef = useRef(runMode);
  formRef.current = form;
  runModeRef.current = runMode;

  const stats = useMemo(() => computeStats(results), [results]);

  // Cancel any in-flight run on unmount.
  useEffect(
    () => () => {
      browserAbortRef.current?.abort();
      serverCtrlRef.current?.stop();
    },
    []
  );

  const validate = (cfg, mode) => {
    const threads = parseInt(cfg.threads, 10) || 0;
    const rampUp = parseInt(cfg.rampUp, 10) || 0;
    const loops = parseInt(cfg.loops, 10) || 0;
    if (!cfg.url || !String(cfg.url).trim()) return 'URL is required';
    if (threads < 1) return 'Threads must be at least 1';
    if (loops < 1) return 'Loops must be at least 1';
    if (rampUp < 0) return 'Ramp-up must be ≥ 0';
    if (mode === 'server') {
      if (threads > SERVER_THREADS_MAX)
        return `Server mode supports up to ${SERVER_THREADS_MAX} threads`;
      if (rampUp > SERVER_RAMPUP_MAX)
        return `Server mode caps ramp-up at ${SERVER_RAMPUP_MAX} seconds (1 hour)`;
      if (loops > SERVER_LOOPS_MAX)
        return `Server mode caps loops at ${SERVER_LOOPS_MAX}`;
    } else if (threads > BROWSER_THREADS_MAX) {
      return `Browser mode supports up to ${BROWSER_THREADS_MAX} threads — switch to Server mode for higher loads`;
    }
    return '';
  };

  const startRun = () => {
    if (running) return;
    const cfg = formRef.current;
    const mode = runModeRef.current;

    const validationError = validate(cfg, mode);
    if (validationError) {
      setRunError(validationError);
      setStatusText('');
      return;
    }

    setRunError('');
    setStatusText('');
    setResults([]);
    setExpanded(new Set());
    setProgress({ done: 0, total: 0 });
    setRunning(true);

    const myRunId = ++runIdRef.current;
    const live = [];
    const pushSample = (sample) => {
      if (runIdRef.current !== myRunId) return;
      live.push(sample);
      setResults([...live].sort((a, b) => a.seq - b.seq));
    };
    const setProgressIfCurrent = (p) => {
      if (runIdRef.current !== myRunId) return;
      setProgress(p);
    };

    const enabledAssertions = collectEnabledAssertions(cfg.assertions);

    if (mode === 'browser') {
      const ctrl = new AbortController();
      browserAbortRef.current = ctrl;
      runSimulation(
        {
          url: cfg.url,
          method: cfg.method,
          contentType: cfg.contentType,
          body: METHODS_WITH_BODY.has(cfg.method) ? cfg.body : '',
          headers: cfg.headers,
          threads: cfg.threads,
          rampUp: cfg.rampUp,
          loops: cfg.loops,
          assertions: enabledAssertions,
        },
        pushSample,
        setProgressIfCurrent,
        ctrl.signal
      )
        .catch((err) => {
          if (runIdRef.current === myRunId) {
            setRunError(err?.message || 'Simulation failed');
          }
        })
        .finally(() => {
          if (runIdRef.current === myRunId) {
            setRunning(false);
            browserAbortRef.current = null;
          }
        });
      return;
    }

    setStatusText('Connecting to server…');
    serverCtrlRef.current = runOnServer(
      {
        testPlanName: cfg.testPlanName,
        threadGroupName: cfg.threadGroupName,
        url: cfg.url,
        method: cfg.method,
        contentType: cfg.contentType,
        body: METHODS_WITH_BODY.has(cfg.method) ? cfg.body : '',
        headers: cfg.headers,
        threads: parseInt(cfg.threads, 10) || 1,
        rampUp: parseInt(cfg.rampUp, 10) || 0,
        loops: parseInt(cfg.loops, 10) || 1,
        assertions: cfg.assertions,
      },
      {
        onSample: pushSample,
        onProgress: setProgressIfCurrent,
        onStatus: (msg) => {
          if (runIdRef.current === myRunId) setStatusText(msg);
        },
        onComplete: () => {
          if (runIdRef.current !== myRunId) return;
          setRunning(false);
          serverCtrlRef.current = null;
        },
        onError: (msg) => {
          if (runIdRef.current !== myRunId) return;
          setRunError(msg || 'Server run failed');
          setStatusText('');
          setRunning(false);
          serverCtrlRef.current = null;
        },
      }
    );
  };

  const stopRun = () => {
    if (!running) return;
    if (runMode === 'browser') {
      browserAbortRef.current?.abort();
    } else {
      serverCtrlRef.current?.stop();
    }
  };

  // External trigger: when the URL bar's Send button bumps runToken, fire a
  // run. The ref guards against the initial mount also seeing the current
  // value as "new".
  const lastTokenRef = useRef(runToken);
  useEffect(() => {
    if (runToken === lastTokenRef.current) return;
    lastTokenRef.current = runToken;
    startRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  const toggleRow = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleModeChange = (next) => {
    if (running) return;
    setRunMode(next);
    setRunError('');
    setStatusText('');
  };

  const requestCount = (parseInt(form.threads, 10) || 0) * (parseInt(form.loops, 10) || 0);

  return (
    <div className="run-panel">
      <div className="run-toolbar">
        <RunModeToggle value={runMode} onChange={handleModeChange} disabled={running} />

        <div className="run-toolbar-spacer" />

        <button
          type="button"
          className="btn btn-primary btn-with-icon"
          onClick={startRun}
          disabled={running}
        >
          <PlayIcon />
          Run
        </button>
        <button
          type="button"
          className={`btn btn-stop btn-with-icon ${running ? 'btn-stop-active' : ''}`}
          onClick={stopRun}
          disabled={!running}
        >
          <StopIcon />
          Stop
        </button>
      </div>

      <div className="run-status-row">
        {runMode === 'server' && (
          <span className="badge badge-accent">
            <ServerIcon />
            Real JMeter
          </span>
        )}
        <span className="run-progress">
          {progress.total > 0
            ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} requests`
            : `${requestCount.toLocaleString()} requests configured`}
        </span>
        {statusText && <span className="badge badge-info">{statusText}</span>}
        {runError && <span className="badge badge-error">{runError}</span>}
      </div>

      {stats ? (
        <>
          <StatsCards stats={stats} />
          <ResultsTable results={results} expanded={expanded} onToggle={toggleRow} />
        </>
      ) : (
        <RunEmptyState />
      )}
    </div>
  );
}

function collectEnabledAssertions(assertions = {}) {
  const out = {};
  if (assertions.responseCode?.enabled) {
    out.responseCode = assertions.responseCode.value;
  }
  if (assertions.responseTime?.enabled) {
    out.maxResponseTime = assertions.responseTime.value;
  }
  if (assertions.bodyContains?.enabled && assertions.bodyContains.value) {
    out.bodyContains = assertions.bodyContains.value;
  }
  return out;
}

function RunModeToggle({ value, onChange, disabled }) {
  return (
    <div className="seg-toggle" role="radiogroup" aria-label="Run mode">
      <button
        type="button"
        role="radio"
        aria-checked={value === 'browser'}
        className={`seg-toggle-btn ${value === 'browser' ? 'on' : ''}`}
        onClick={() => onChange('browser')}
        disabled={disabled}
      >
        Browser
        <span className="seg-toggle-sub">quick check</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === 'server'}
        className={`seg-toggle-btn ${value === 'server' ? 'on' : ''}`}
        onClick={() => onChange('server')}
        disabled={disabled}
      >
        Server
        <span className="seg-toggle-sub">real JMeter</span>
      </button>
    </div>
  );
}

function StatsCards({ stats }) {
  return (
    <div className="stat-grid">
      <StatCard label="Total" value={stats.total} />
      <StatCard label="Passed" value={stats.passed} tone="ok" />
      <StatCard label="Failed" value={stats.failed} tone="err" />
      <StatCard label="Avg" value={stats.avg} unit="ms" />
      <StatCard label="Min" value={stats.min} unit="ms" />
      <StatCard label="Max" value={stats.max} unit="ms" />
      <StatCard label="p50" value={stats.p50} unit="ms" />
      <StatCard label="p95" value={stats.p95} unit="ms" />
    </div>
  );
}

function StatCard({ label, value, unit, tone }) {
  return (
    <div className={`stat-card ${tone ? `stat-card-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {Number(value).toLocaleString()}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

function statusTone(code) {
  if (code === 'ERR' || typeof code === 'string') {
    const n = parseInt(code, 10);
    if (Number.isFinite(n)) return classifyHttp(n);
    return 'err';
  }
  if (typeof code === 'number') return classifyHttp(code);
  return 'neutral';
}

function classifyHttp(n) {
  if (n >= 200 && n < 300) return 'ok';
  if (n >= 300 && n < 400) return 'warn';
  if (n >= 400) return 'err';
  return 'neutral';
}

function ResultsTable({ results, expanded, onToggle }) {
  if (!results.length) return null;
  return (
    <div className="results-wrap">
      <div className="results-table" role="table">
        <div className="results-row results-head" role="row">
          <span className="rcol-num">#</span>
          <span className="rcol-thread">Thread</span>
          <span className="rcol-iter">Iter</span>
          <span className="rcol-status">Status</span>
          <span className="rcol-time">Time</span>
          <span className="rcol-result">Result</span>
        </div>
        {results.map((r, i) => {
          const open = expanded.has(r.id);
          const tone = statusTone(r.error ? 'ERR' : r.status);
          return (
            <div
              key={r.id}
              className={`results-row-wrap ${open ? 'open' : ''} ${
                i % 2 === 0 ? 'zebra-a' : 'zebra-b'
              }`}
            >
              <button
                type="button"
                className="results-row results-body-row"
                onClick={() => onToggle(r.id)}
                aria-expanded={open}
                role="row"
              >
                <span className="rcol-num">{i + 1}</span>
                <span className="rcol-thread">{r.thread}</span>
                <span className="rcol-iter">{r.iter}</span>
                <span className="rcol-status">
                  <span className={`status-chip status-chip-${tone}`}>
                    {r.error ? 'ERR' : r.status}
                  </span>
                </span>
                <span className="rcol-time">{r.timeMs}<span className="rcol-time-unit">ms</span></span>
                <span className="rcol-result">
                  {r.pass ? (
                    <span className="result-pill result-pill-pass">
                      <CheckIcon size={11} /> Passed
                    </span>
                  ) : (
                    <span className="result-pill result-pill-fail">
                      <XIcon size={11} /> Failed
                    </span>
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
        <div className="detail-error">
          <strong>Error:</strong> {sample.error}
        </div>
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
                <span className="assert-mark">
                  {a.pass ? <CheckIcon size={11} /> : <XIcon size={11} />}
                </span>
                <span className="assert-name">{a.name}</span>
                <span className="assert-meta">
                  expected <code>{String(a.expected)}</code> · got{' '}
                  <code>{String(a.actual)}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-block">
        <div className="detail-label">Body preview</div>
        <pre className="body-preview">
          {sample.bodyPreview || (
            <em className="dim">
              {sample.error
                ? '(no body — request failed)'
                : '(empty body, or server-mode run did not capture body)'}
            </em>
          )}
        </pre>
      </div>
    </div>
  );
}

function RunEmptyState() {
  return (
    <div className="run-empty">
      <div className="run-empty-icon">
        <PaperAirplaneIcon size={56} />
      </div>
      <div className="run-empty-title">Run your first test</div>
      <div className="run-empty-sub">
        Configure your request above, then click Run or hit Send to execute.
      </div>
    </div>
  );
}
