/**
 * Browser-side simulator that mirrors JMeter ThreadGroup semantics.
 *
 * Total requests = threads * loops.
 * Each thread starts after `(rampUp * 1000) / threads * threadIndex` ms,
 * then runs its loops sequentially. Threads execute in parallel.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * @param {{
 *   url: string,
 *   method?: string,
 *   contentType?: string,
 *   body?: string,
 *   headers?: { name: string, value: string }[],
 *   threads: number|string,
 *   rampUp: number|string,
 *   loops: number|string,
 *   assertions: { responseCode?: string, maxResponseTime?: number|string, bodyContains?: string }
 * }} config
 * @param {(sample: object) => void} [onSample]
 * @param {(progress: { done: number, total: number }) => void} [onProgress]
 * @param {AbortSignal} [signal]  When aborted, in-flight fetches are cancelled
 *   and no new samples are scheduled. Already-completed samples are still
 *   returned and reported via onSample.
 * @returns {Promise<object[]>}
 */
export async function runSimulation(config, onSample, onProgress, signal) {
  const url = String(config.url || '').trim();
  if (!url) throw new Error('URL is required');

  const method = String(config.method || 'GET').toUpperCase();
  const threads = Math.max(1, parseInt(config.threads, 10) || 1);
  const loops = Math.max(1, parseInt(config.loops, 10) || 1);
  const rampUp = Math.max(0, Number(config.rampUp) || 0);
  const assertions = config.assertions || {};
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const body = config.body ?? '';
  const contentType = config.contentType || '';

  const total = threads * loops;
  const stagger = threads > 0 ? (rampUp * 1000) / threads : 0;

  const samples = [];
  let completed = 0;
  let order = 0;

  const threadJobs = [];
  for (let t = 0; t < threads; t++) {
    const startDelay = stagger * t;
    threadJobs.push(
      (async () => {
        if (startDelay > 0) await sleep(startDelay);
        for (let l = 0; l < loops; l++) {
          if (signal?.aborted) return;
          const sample = await runOneSample({
            url,
            method,
            body,
            contentType,
            headers,
            assertions,
            thread: t + 1,
            iter: l + 1,
            seq: ++order,
            signal,
          });
          samples.push(sample);
          completed += 1;
          onSample?.(sample);
          onProgress?.({ done: completed, total });
        }
      })()
    );
  }

  await Promise.all(threadJobs);
  return samples;
}

async function runOneSample(config) {
  const { url, method, body, contentType, headers, assertions, signal } = config;
  const sample = {
    seq: config.seq,
    id: `${config.thread}-${config.iter}-${config.seq}`,
    thread: config.thread,
    iter: config.iter,
    status: null,
    timeMs: 0,
    error: null,
    bodyPreview: '',
    assertionResults: [],
    pass: false,
  };

  const willSendBody = METHODS_WITH_BODY.has(method) && body !== '';

  const fetchOptions = {
    method,
    headers: buildHeadersObject(
      headers,
      contentType,
      willSendBody ? body : ''
    ),
  };
  if (willSendBody) {
    fetchOptions.body = body;
  }
  if (signal) {
    fetchOptions.signal = signal;
  }

  const startedAt = performance.now();
  try {
    const res = await fetch(url, fetchOptions);
    const text = await res.text();
    sample.timeMs = Math.round(performance.now() - startedAt);
    sample.status = res.status;
    sample.bodyPreview = truncate(text, 200);
    sample.assertionResults = evaluateAssertions(
      assertions,
      res.status,
      sample.timeMs,
      text
    );
    sample.pass =
      sample.error === null &&
      sample.assertionResults.every((r) => r.pass);
  } catch (err) {
    sample.timeMs = Math.round(performance.now() - startedAt);
    sample.error = err?.name === 'AbortError'
      ? 'Stopped by user'
      : (err?.message || 'Network error');
    sample.status = 'ERR';
    sample.assertionResults = [];
    sample.pass = false;
  }
  return sample;
}

/**
 * Convert the form's header list into a plain object suitable for
 * fetch(). When a body is being sent and the user hasn't already
 * supplied a Content-Type header, fall back to the form's content-type
 * dropdown so the request is well-formed.
 */
export function buildHeadersObject(headers, contentType, body) {
  const out = {};
  let userSetContentType = false;

  for (const h of headers || []) {
    const name = String(h?.name ?? '').trim();
    if (!name) continue;
    if (name.toLowerCase() === 'content-type') userSetContentType = true;
    out[name] = String(h?.value ?? '');
  }

  if (body && !userSetContentType && contentType) {
    out['Content-Type'] = contentType;
  }

  return out;
}

function evaluateAssertions(assertions, status, ms, body) {
  const out = [];

  if (assertions.responseCode !== undefined && assertions.responseCode !== '') {
    const expected = String(assertions.responseCode);
    const actual = String(status);
    out.push({
      name: 'Response Code',
      expected: `= ${expected}`,
      actual,
      pass: actual === expected,
    });
  }

  if (
    assertions.maxResponseTime !== undefined &&
    assertions.maxResponseTime !== '' &&
    !Number.isNaN(Number(assertions.maxResponseTime))
  ) {
    const max = Number(assertions.maxResponseTime);
    out.push({
      name: 'Response Time',
      expected: `≤ ${max} ms`,
      actual: `${ms} ms`,
      pass: ms <= max,
    });
  }

  if (
    assertions.bodyContains !== undefined &&
    assertions.bodyContains !== '' &&
    assertions.bodyContains !== null
  ) {
    const needle = String(assertions.bodyContains);
    out.push({
      name: 'Body Contains',
      expected: needle,
      actual: body.includes(needle) ? 'matched' : 'not found',
      pass: body.includes(needle),
    });
  }

  return out;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Compute summary stats from a (possibly partial) results array.
 * Returns null when there are zero samples.
 */
export function computeStats(samples) {
  if (!samples || samples.length === 0) return null;

  const times = samples.map((s) => s.timeMs).sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const passed = samples.filter((s) => s.pass).length;
  const failed = samples.length - passed;

  const idx = (q) =>
    Math.min(times.length - 1, Math.max(0, Math.floor(q * times.length)));

  return {
    total: samples.length,
    passed,
    failed,
    avg: Math.round(sum / times.length),
    min: times[0],
    max: times[times.length - 1],
    p50: times[idx(0.5)],
    p95: times[idx(0.95)],
  };
}
