/**
 * Client-side wrapper around the Flask backend's SSE run API.
 *
 * Backend lives at `${API_BASE}` (set via VITE_API_URL — empty string means
 * same origin, which is what the vite dev proxy handles).
 *
 * runOnServer(config, callbacks) returns a controller you can stop():
 *
 *   const ctrl = runOnServer(config, {
 *     onSample, onProgress, onStatus, onComplete, onError,
 *   });
 *   ctrl.stop();   // calls /api/run/<id>/stop and closes the EventSource
 */

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

let serverSeq = 0;

/**
 * Convert the shape the backend emits into the shape the existing browser
 * simulator emits (so the rest of the UI doesn't have to care).
 *
 * Backend: { id, threadNum, iteration, code, ms, passed, assertions, error }
 * UI:      { seq, id, thread, iter, status, timeMs, error, bodyPreview,
 *            assertionResults, pass }
 */
function adaptSample(s) {
  return {
    seq: ++serverSeq,
    id: s.id,
    thread: s.threadNum ?? 0,
    iter: s.iteration ?? 0,
    status: s.code ?? 'ERR',
    timeMs: typeof s.ms === 'number' ? s.ms : 0,
    error: s.error || null,
    bodyPreview: '',
    assertionResults: Array.isArray(s.assertions)
      ? s.assertions.map((a) => ({
          name: a.name || 'Assertion',
          expected: a.expected ?? '',
          actual: a.actual ?? '',
          pass: !!a.pass,
        }))
      : [],
    pass: !!s.passed,
  };
}

export function runOnServer(config, callbacks = {}) {
  const { onSample, onProgress, onStatus, onComplete, onError } = callbacks;

  let runId = null;
  let es = null;
  let stopped = false;
  let finished = false;

  const safeClose = () => {
    if (es) {
      try {
        es.close();
      } catch {
        // ignore
      }
      es = null;
    }
  };

  const finish = (mode, payload) => {
    if (finished) return;
    finished = true;
    safeClose();
    if (mode === 'complete') onComplete?.(payload);
    else if (mode === 'error') onError?.(payload);
  };

  const start = async () => {
    onStatus?.('Connecting to server…');
    let res;
    try {
      res = await fetch(`${API_BASE}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    } catch (err) {
      finish('error', err?.message || 'Could not reach backend');
      return;
    }

    if (!res.ok) {
      let message = `Backend error ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch {
        // body wasn't JSON; keep the status-based message
      }
      finish('error', message);
      return;
    }

    let body;
    try {
      body = await res.json();
    } catch (err) {
      finish('error', 'Backend returned malformed response');
      return;
    }

    runId = body?.runId;
    if (!runId) {
      finish('error', 'Backend did not return a runId');
      return;
    }

    if (stopped) {
      // User clicked Stop before the POST returned — fire off a stop
      // request and bail without ever opening the stream.
      void postStop(runId);
      finish('error', 'Stopped by user');
      return;
    }

    onStatus?.('Running on server (real JMeter)');
    es = new EventSource(`${API_BASE}/api/run/${runId}/stream`);

    es.addEventListener('sample', (e) => {
      try {
        onSample?.(adaptSample(JSON.parse(e.data)));
      } catch {
        // skip malformed event
      }
    });

    es.addEventListener('progress', (e) => {
      try {
        onProgress?.(JSON.parse(e.data));
      } catch {
        // skip
      }
    });

    es.addEventListener('complete', (e) => {
      let data = {};
      try {
        data = JSON.parse(e.data);
      } catch {
        // ignore
      }
      onStatus?.(data?.stats?.stopped ? 'Stopped' : 'Complete');
      finish('complete', data);
    });

    es.addEventListener('error', (e) => {
      // Two flavors share this listener:
      //   1. Server-sent "event: error" with a JSON payload (e.data set)
      //   2. EventSource's native error (network/connection drop, no e.data)
      // If we already finished cleanly, ignore stray network errors that
      // arrive after the connection close.
      if (finished) {
        safeClose();
        return;
      }
      if (e.data) {
        let message = 'Server error';
        try {
          const parsed = JSON.parse(e.data);
          if (parsed?.message) message = parsed.message;
        } catch {
          message = String(e.data);
        }
        finish('error', message);
      } else {
        finish('error', 'Lost connection to backend');
      }
    });
  };

  void start();

  return {
    stop() {
      if (finished) return;
      stopped = true;
      onStatus?.('Stopping…');
      if (runId) {
        void postStop(runId);
      }
      // Don't close EventSource yet — wait for the server's `complete` (with
      // stopped:true) or `error` event so the stats reflect the partial run.
    },
  };
}

async function postStop(runId) {
  try {
    await fetch(`${API_BASE}/api/run/${runId}/stop`, { method: 'POST' });
  } catch {
    // Best-effort. The /complete event will still fire when the subprocess
    // exits (or the SSE will drop on its own).
  }
}

export function getApiBase() {
  return API_BASE;
}
