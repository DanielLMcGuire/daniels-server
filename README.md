# Zorvix

[![npm version](https://badge.fury.io/js/zorvix.svg)](https://www.npmjs.com/package/zorvix)
[![Node Version](https://img.shields.io/node/v/zorvix.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/DanielLMcGuire/Zorvix/ci.yml)](https://github.com/DanielLMcGuire/Zorvix/actions/workflows/ci.yml?query=event%3Apush+branch%3Amaster)


A zero-dependency Node.js static file server with support for clustering, TLS, HTTP caching, range requests, gzip, and Chrome DevTools workspace integration.

---

## Usage

```bash
# Install from NPM
npm install -g zorvix 
# Run
zorvix <port> [options]
```

### Options

| Flag | Description |
|---|---|
| `<port>` | Port to listen on (required) |
| `-r, --root <dir>` | Directory to serve (default: `process.cwd()`) |
| `-l, --log` | Enable request logging |
| `--dev` | Dev mode: single process, exit on uncaught exception |
| `-dt, --devtools` | Enable Chrome DevTools workspace integration |
| `--key <file>` | Path to PEM private key, enables HTTPS (requires `--cert`) |
| `--cert <file>` | Path to PEM certificate, enables HTTPS (requires `--key`) |
| `-h, --help` | Print help and exit |

### Examples

```bash
# Serve the current directory on port 8080
zorvix 8080

# Serve a specific directory with request logging
zorvix 3000 --root ./dist -l

# HTTPS
zorvix 443 --key ./key.pem --cert ./cert.pem

# Dev mode with DevTools workspace
zorvix 8080 --dev --devtools -l
```

---

## API

`api.mts` exports `createServer()` for embedding the server in your own code. In addition to static file serving, you can register REST routes and middleware that run before the static layer.

```ts
import { createServer } from 'zorvix';

const server = createServer({ port: 8080, root: './public', logging: true });

// Global middleware — runs for every request before routes and static serving
server.use((req, res, next) => {
    res.setHeader('X-Custom-Header', 'hello');
    next();
});

// Path-prefixed middleware — only runs when the URL starts with /api
server.use('/api', (req, res, next) => {
    if (!req.headers['x-api-key']) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorised' }));
        return;
    }
    next();
});

// REST routes
server
    .get('/api/users', (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, name: 'Alice' }]));
    })
    .post('/api/users', (req, res) => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: true }));
    })
    .get('/api/users/:id', (req, res) => {
        // Named path segments are available on req.params
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: req.params.id }));
    })
    .delete('/api/users/:id', (req, res) => {
        res.writeHead(204);
        res.end();
    });

// Unmatched GET / HEAD requests fall through to static file serving as normal.

await server.start();
console.log(`Listening on port ${server.port}`);

// Later…
await server.stop();
```

### `ServerOptions`

| Property | Type | Description |
|---|---|---|
| `port` | `number` | Port to listen on |
| `root` | `string` | Directory to serve (default: `process.cwd()`) |
| `logging` | `boolean` | Log requests to stdout (default: `false`) |
| `devTools` | `boolean` | Enable Chrome DevTools workspace (default: `false`) |
| `key` | `string \| Buffer` | TLS private key path or PEM buffer |
| `cert` | `string \| Buffer` | TLS certificate path or PEM buffer |

### `ServerInstance`

| Member | Description |
|---|---|
| `.use(handler)` | Register global middleware |
| `.use(path, handler)` | Register path-prefixed middleware |
| `.get(path, handler)` | Register a GET route |
| `.post(path, handler)` | Register a POST route |
| `.put(path, handler)` | Register a PUT route |
| `.patch(path, handler)` | Register a PATCH route |
| `.delete(path, handler)` | Register a DELETE route |
| `.head(path, handler)` | Register a HEAD route |
| `.options(path, handler)` | Register an OPTIONS route |
| `.start()` | Start listening, resolves when ready |
| `.stop()` | Gracefully stop the server |
| `.root` | Resolved absolute path being served |
| `.port` | Port number |
| `.listening` | `true` while the server is active |
| `.server` | The underlying `http.Server` / `https.Server` |

### Route paths

Route paths passed to the method helpers support two dynamic segments:

| Syntax | Example | Captured as |
|---|---|---|
| `:name` | `/users/:id` | `req.params.id` |
| `*` | `/static/*` | `req.params['0']` |

`req.params` is always defined on every request (an empty object `{}` for middleware and static-file requests that did not match a route).

### Handler execution order

Handlers and routes are executed in **registration order**. Each handler must either end the response or call `next()` to pass control forward. Calling `next(err)` with a value skips the remaining chain and triggers the built-in 500 error handler.

```
global middleware → path-prefixed middleware → matching route → static file serving
```

Unmatched `GET` and `HEAD` requests always fall through to static file serving. Any other method that reaches the end of the chain without being handled returns `405 Method Not Allowed` with an `Allow` header listing the methods that do have a registered route for that path.

---

## Features

**REST routing**: `createServer()` supports method-specific route registration (`.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.head()`, `.options()`) with named path parameters (`:id`) and wildcards (`*`).

**Middleware**: `.use()` registers handlers that run before routes and static serving. Mount at a path prefix or globally.

**Caching & conditional requests**: responses include `ETag` and `Last-Modified` headers. `If-None-Match` and `If-Modified-Since` are honoured with `304 Not Modified` responses.

**Range requests**: `Accept-Ranges: bytes` is advertised and `Range` / `If-Range` headers are handled, enabling video seeking and resumable downloads.

**Gzip**: responses are compressed when the client sends `Accept-Encoding: gzip`.

**Content-Disposition**: binary/attachment file types are served with a `Content-Disposition: attachment` header so the browser downloads rather than opens them.

**TLS**: pass `--key` and `--cert` (or the equivalent `ServerOptions` fields) to upgrade to HTTPS. Both file paths and pre-loaded `Buffer`s are accepted.

**Chrome DevTools workspace**: `--devtools` / `-dt` registers the server root as a DevTools workspace by serving the required `.well-known` JSON endpoint, enabling live editing of source files directly from the browser.

**Graceful shutdown**: `SIGINT` (Ctrl-C) triggers a graceful close. A second `SIGINT` forces an immediate exit.

**Worker supervision**: in clustered mode the primary automatically restarts a worker that exits unexpectedly (crashes, OOM). Workers that exit cleanly due to a signal are not restarted.

---

## Security

- Path traversal is blocked: resolved file paths are checked to ensure they remain inside `root`.
- URLs longer than the configured maximum return `414 URI Too Long`.
- Requests with excessive headers return `431 Request Header Fields Too Large`.
- Requests that do not match any registered route and are not `GET` or `HEAD` return `405 Method Not Allowed` with an accurate `Allow` header.
