// Run with: node scripts/check_jmx_parity.mjs
// Spits out the JS-built JMX for several configs to stdout, separated by
// "===CONFIG <i>===" headers. The Python parity script reads this to compare.

import { buildJmx } from '../src/jmx-builder.js';

const configs = [
  // 1. Minimal GET, no headers, no assertions
  {
    testPlanName: 'Minimal GET',
    threadGroupName: 'Workers',
    url: 'https://api.example.com/v1/health',
    method: 'GET',
    threads: 5,
    rampUp: 2,
    loops: 3,
    assertions: {
      responseCode: { enabled: false },
      responseTime: { enabled: false },
      bodyContains: { enabled: false },
    },
  },
  // 2. GET with all assertions enabled and a couple headers
  {
    testPlanName: 'GET with assertions & headers',
    threadGroupName: 'Threads',
    url: 'https://api.open-meteo.com/v1/forecast?latitude=38.99&longitude=-76.94&current=temperature_2m',
    method: 'GET',
    headers: [
      { name: 'Accept', value: 'application/json' },
      { name: 'User-Agent', value: 'jmx-test/0.1 <hi>' },
    ],
    threads: 10,
    rampUp: 5,
    loops: 1,
    assertions: {
      responseCode: { enabled: true, value: '200' },
      responseTime: { enabled: true, value: 1500 },
      bodyContains: { enabled: true, value: 'temperature_2m' },
    },
  },
  // 3. POST JSON with a body, content-type header NOT pre-set
  {
    testPlanName: 'POST JSON',
    threadGroupName: 'Posters',
    url: 'https://jsonplaceholder.typicode.com/posts',
    method: 'POST',
    contentType: 'application/json',
    body: '{"title":"a&b","body":"<p>hi</p>","userId":1}',
    headers: [{ name: 'Authorization', value: 'Bearer xyz' }],
    threads: 3,
    rampUp: 1,
    loops: 2,
    assertions: {
      responseCode: { enabled: true, value: '201' },
      responseTime: { enabled: false },
      bodyContains: { enabled: true, value: '"id"' },
    },
  },
  // 4. PUT with content-type header already set in headers list (no auto-add)
  {
    testPlanName: 'PUT user-supplied content-type',
    threadGroupName: 'Putters',
    url: 'http://example.com:8080/api/things/1?x=1&y=2',
    method: 'PUT',
    contentType: 'application/json',
    body: '{"id":1}',
    headers: [{ name: 'content-type', value: 'application/vnd.api+json' }],
    threads: 1,
    rampUp: 0,
    loops: 1,
    assertions: {
      responseCode: { enabled: true, value: '200' },
      responseTime: { enabled: false },
      bodyContains: { enabled: false },
    },
  },
  // 5. DELETE — no body even if one is provided
  {
    testPlanName: 'DELETE',
    threadGroupName: 'Deleters',
    url: 'https://api.example.com/items/42',
    method: 'DELETE',
    body: 'should be ignored',
    threads: 2,
    rampUp: 1,
    loops: 1,
    assertions: {
      responseCode: { enabled: true, value: '204' },
      responseTime: { enabled: false },
      bodyContains: { enabled: false },
    },
  },
  // 6. XML-special chars in test plan & header & body to exercise escaping
  {
    testPlanName: 'Names with <special> & "chars" \'too\'',
    threadGroupName: 'TG <1>',
    url: 'https://api.example.com/v1/echo',
    method: 'PATCH',
    contentType: 'text/plain',
    body: '<root attr="v">&amp;\'</root>',
    headers: [
      { name: 'X-Weird-Name', value: '<v "1" & v\'s>' },
      { name: '   trimmed   ', value: 'ok' },
    ],
    threads: 1,
    rampUp: 0,
    loops: 1,
    assertions: {
      responseCode: { enabled: true, value: '200' },
      responseTime: { enabled: true, value: 500 },
      bodyContains: { enabled: true, value: '<root attr="v">&amp;\'</root>' },
    },
  },
];

const out = configs
  .map((c, i) => `===CONFIG ${i}===\n${buildJmx(c)}`)
  .join('');

process.stdout.write(out);
