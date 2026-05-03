# JMX Test Plan Builder

A fully client-side React app that generates Apache JMeter (`.jmx`) test plans
for HTTP API load tests, with a built-in browser simulator so you can sanity
check assertions before exporting to JMeter.

## Features

- **All five HTTP methods**: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- **Request body editor** for POST / PUT / PATCH with Content-Type dropdown
  (`application/json`, `application/x-www-form-urlencoded`, `text/plain`) and
  on-blur JSON validation
- **Custom headers** with quick-add presets for `Authorization`, `Accept`,
  `User-Agent`, `X-API-Key`
- **Live JMX preview** rendered as you type
- **Browser-based simulator** that mirrors JMeter `ThreadGroup` semantics
  (threads × loops, ramp-up stagger, response code / response time / body
  contains assertions)
- **Optional server-side runner** — a Python/Flask backend that executes
  the generated `.jmx` with real JMeter and streams results back over
  Server-Sent Events. Toggle "Server" in the Run tab to use it.
- **JMeter 5.6.3 compatible** output
- **Browser mode is fully client-side** — server mode is opt-in and runs
  in a separate process

## Getting started

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

To build for production:

```bash
npm run build
npm start
```

## End-to-end test inputs

After making changes, verify the following five flows work end-to-end —
form → preview → run → download — by pasting each into the form and
clicking **Run Test**.

### 1. GET — Open-Meteo

- **URL**: `https://api.open-meteo.com/v1/forecast?latitude=38.99&longitude=-76.94&current=temperature_2m`
- **Method**: `GET`
- **Body**: none
- **Assertions**:
  - Response code = `200`
  - Body contains `temperature_2m`

### 2. POST — JSONPlaceholder

- **URL**: `https://jsonplaceholder.typicode.com/posts`
- **Method**: `POST`
- **Content-Type**: `application/json`
- **Body**:
  ```json
  {"title": "test", "body": "load test", "userId": 1}
  ```
- **Assertions**:
  - Response code = `201`
  - Body contains `"id"`

### 3. PUT — JSONPlaceholder

- **URL**: `https://jsonplaceholder.typicode.com/posts/1`
- **Method**: `PUT`
- **Content-Type**: `application/json`
- **Body**:
  ```json
  {"id": 1, "title": "updated", "body": "new content", "userId": 1}
  ```
- **Assertions**:
  - Response code = `200`
  - Body contains `updated`

### 4. PATCH — JSONPlaceholder

- **URL**: `https://jsonplaceholder.typicode.com/posts/1`
- **Method**: `PATCH`
- **Content-Type**: `application/json`
- **Body**:
  ```json
  {"title": "patched"}
  ```
- **Assertions**:
  - Response code = `200`
  - Body contains `patched`

### 5. DELETE — JSONPlaceholder

- **URL**: `https://jsonplaceholder.typicode.com/posts/1`
- **Method**: `DELETE`
- **Body**: none
- **Assertions**:
  - Response code = `200`

> **Note**: When you switch the method to `DELETE`, the form auto-fills the
> expected response code as `204` (the conventional value for "No Content"
> deletes). JSONPlaceholder is unusual in that it returns `200` instead of
> `204` for `DELETE /posts/:id`, so you'll need to manually change the
> expected code to `200` for this specific test to pass. Most real APIs
> return `204` and the default will be correct.

## Default response codes by method

When you switch HTTP methods, the form auto-suggests the conventional success
code for that method (only if you haven't manually edited the field):

| Method | Default expected code |
| ------ | --------------------- |
| GET    | `200`                 |
| POST   | `201`                 |
| PUT    | `200`                 |
| PATCH  | `200`                 |
| DELETE | `204`                 |

## CORS note

The in-browser simulator uses the standard `fetch` API, so it is subject to
the same CORS rules as any other browser request. Public APIs that emit the
appropriate `Access-Control-Allow-Origin` header (Open-Meteo, JSONPlaceholder,
GitHub's public API, etc.) work fine. APIs that don't will fail in the
simulator — but the generated `.jmx` file will still run correctly in
JMeter, which doesn't enforce CORS.

## What's out of scope

The following are intentionally **not** supported (PRs welcome, but not on
the roadmap):

- File uploads / `multipart/form-data`
- GraphQL-specific helpers (use `POST` with `application/json`)
- Cookies / session management
- Header-level assertions (the only assertions are response code, response
  time, and body contains)
- Per-request method (every request in a generated test plan uses the same
  method, matching JMeter's `HTTPSamplerProxy` model)

## Project layout

```
src/
  App.jsx          React UI (form, preview, run panel, mode toggle)
  jmx-builder.js   Build the .jmx XML from the form state
  simulator.js     Browser-side ThreadGroup simulator (browser run mode)
  server-runner.js Client wrapper around the Flask backend SSE stream
  utils.js         XML escaping + URL parsing helpers
  styles.css       All styling
  main.jsx         App entry point

server/
  app.py           Flask app: /api/run, /api/run/<id>/stream, /stop, /health
  jmx_builder.py   Python port of jmx-builder.js (byte-for-byte parity)
  jtl_parser.py    Streams JMeter JTL CSV output as the file is written
  requirements.txt flask, flask-cors, gunicorn
  Dockerfile       python + openjdk + JMeter 5.6.3

scripts/
  check_jmx_parity.mjs   Dump JS-built JMX for several configs
  check_jmx_parity.py    Diff JS vs Python output (run this after edits)
```

## Server (real JMeter) mode

The browser simulator is great for sanity checks but is bounded by browser
fetch limits and CORS. The optional Python backend runs the generated
`.jmx` against real JMeter and streams the results live.

### Run the backend locally

You'll need Python 3.11+, Java 17, and Apache JMeter 5.6.3 on your `PATH`.
The easiest way is the Docker image:

```bash
cd server
docker build -t jmx-backend .
docker run --rm -p 5000:5000 jmx-backend
# verify:
curl http://localhost:5000/api/health
# → {"jmeter_version": "5.6.3", "ok": true}
```

Or, if JMeter is installed locally:

```bash
cd server
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python app.py     # listens on :5000
```

Then run the frontend dev server in another terminal — it proxies `/api/*`
to `localhost:5000` automatically:

```bash
npm run dev
```

In the Run tab, switch the toggle to **Server**. Click **▶ Run** and you'll
see real JMeter samples populate the table as JMeter writes them. The
**■ Stop** button SIGTERMs the JMeter subprocess.

### Production deployment

Set `VITE_API_URL` at build time when the backend is on a different origin
(e.g. a separate Railway service):

```bash
VITE_API_URL=https://jmx-backend.example.app npm run build
```

The backend uses gunicorn with the `gthread` worker class so SSE streams
don't tie up workers (each open stream holds a thread, not a process).

### Caps

The backend rejects runs above these limits with a `400`; the UI also
validates client-side:

| Setting   | Cap   |
| --------- | ----- |
| Threads   | 5000  |
| Ramp-up   | 3600s |
| Loops     | 10000 |

A single run also has a hard 10-minute server-side timeout.
