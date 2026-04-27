/**
 * Browser-side simulator that mirrors JMeter ThreadGroup semantics.
 *
 * Total requests = threads * loops.
 * Each thread starts after `(rampUp * 1000) / threads * threadIndex` ms,
 * then runs its loops sequentially. Threads execute in parallel.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   url: string,
 *   threads: number|string,
 *   rampUp: number|string,
 *   loops: number|string,
 *   assertions: { responseCode?: string, maxResponseTime?: number|string, bodyContains?: string }
 * }} config
 * @param {(sample: object) => void} [onSample]
 * @param {(progress: { done: number, total: number }) => void} [onProgress]
 * @returns {Promise<object[]>}
 */
export async function runSimulation(config, onSample, onProgress) {
  const url = String(config.url || '').trim();
  if (!url) throw new Error('URL is required');

  const threads = Math.max(1, parseInt(config.threads, 10) || 1);
  const loops = Math.max(1, parseInt(config.loops, 10) || 1);
  const rampUp = Math.max(0, Number(config.rampUp) || 0);
  const assertions = config.assertions || {};

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
          const sample = await runOne({
            url,
            assertions,
            thread: t + 1,
            iter: l + 1,
            seq: ++order,
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

async function runOne({ url, assertions, thread, iter, seq }) {
  const sample = {
    seq,
    id: `${thread}-${iter}-${seq}`,
    thread,
    iter,
    status: null,
    timeMs: 0,
    error: null,
    bodyPreview: '',
    assertionResults: [],
    pass: false,
  };

  const startedAt = performance.now();
  try {
    const res = await fetch(url, { method: 'GET' });
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
    sample.error = err?.message || 'Network error';
    sample.status = 'ERR';
    sample.assertionResults = [];
    sample.pass = false;
  }
  return sample;
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
