# Zorvix

[![npm version](https://img.shields.io/npm/v/zorvix.svg)](https://www.npmjs.com/package/zorvix)
[![Node Version](https://img.shields.io/node/v/zorvix.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NPM Downloads](https://img.shields.io/npm/dw/zorvix)](https://www.npmjs.com/package/zorvix)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/DanielLMcGuire/Zorvix/ci.yml.svg?label=npm%20run%20test
)](https://github.com/DanielLMcGuire/Zorvix/actions/workflows/ci.yml?query=event%3Apush+branch%3Amaster)

A typed zero-dependency Node.js http/https server supporting CLI with in-built clustering, caching, and an API that adds REST routing and Express style middleware support.

[Full Benchmarks](https://github.com/DanielLMcGuire/Zorvix/wiki/Benchmarks) <sub>against Express and 0http</sub>

---

## CLI

```bash
npx zorvix <port> [options]
```
 
| Flag | Description |
|---|---|
| `<port>` | Port to listen on (required) |
| `-r, --root <dir>` | Directory to serve (default: `cwd`) |
| `-l, --log` | Enable request logging |
| `--dev` | Single process, no cache, exit on uncaught exception |
| `-dt, --devtools` | Enable Chrome DevTools workspace |
| `--key / --cert` | PEM key and cert files to enable HTTPS |

 
```bash
npx zorvix 8080                          # Serve current directory
npx zorvix 3000 --root ./dist -l         # Serve ./dist with logging
npx zorvix 443 --key ./key.pem --cert ./cert.pem  # HTTPS
npx zorvix 8080 --dev --devtools -l      # Dev mode + DevTools
```

#### [Full `zorvix(1)` documentation](https://github.com/DanielLMcGuire/Zorvix/wiki/zorvix.1)

### Examples

```bash
# Serve the current directory on port 8080
npx zorvix 8080

# Serve a specific directory with request logging
npx zorvix 3000 --root ./dist -l

# HTTPS
npx zorvix 443 --key ./key.pem --cert ./cert.pem

# Dev mode with DevTools workspace
npx zorvix 8080 --dev --devtools -l
```

---

## API

### `createServer(options)`

Creates and returns a `ServerInstance`. Use this for single-process servers, tests, and any case where you don't need workers`.

```ts
import { createServer } from 'zorvix';

const server = createServer({
    port: 3000,
    root: './public',
    logging: true,
});

server.get('/hello', (req, res) => res.end('Hello, world!'));

await server.start();
await server.stop();
```

### `serve(options, setup)`

Use `serve` instead of `createServer` when `workers: true`. Any code that must run inside a worker (connections, setup, route registration, etc) belongs INSIDE the callback.

```ts
import { serve } from 'zorvix';

// All dependencies must be initialized inside (use import(), not import!), not in the outer scope!
serve({
    port: 3000,
    root: './public',
    logging: true,
    workers: true,
    key: './server.key',
    cert: './server.crt',
}, async (server) => {
    // Only runs in worker processes
    await db.connect();

    server.use('/api', authMiddleware);

    server.get('/users/:id', async (req, res) => {
        res.json(await db.findUser(req.params.id));
    });

    server.post('/users', async (req, res) => {
        res.json(await db.createUser(req.body), 201);
    });

    await server.start();
});
```

### Routes and middleware

Both `createServer` and `serve` return/provide a `ServerInstance` with the same API:

```ts
server.use((req, res, next) => { next(); });
server.use('/api', authMiddleware);

server.get('/users/:id',    (req, res) => res.end(req.params.id));
server.post('/users',       handler);
server.put('/users/:id',    handler);
server.patch('/users/:id',  handler);
server.delete('/users/:id', handler);
server.head('/users/:id',   handler);
server.options('/users',    handler);

await server.start();
await server.stop();
```

#### [Full `zorvix(3)` documentation](https://github.com/DanielLMcGuire/Zorvix/wiki/zorvix.3)

---

<img src="https://zorvix.pages.dev/bench-latest.svg" width="700"></img>

## Features

- **Caching** - `ETag` (SHA-1 for cached files, mtime-based for streamed) and `Last-Modified` headers; `304 Not Modified` for `If-None-Match` / `If-Modified-Since`
- **Range requests** - `Accept-Ranges: bytes` advertised; `Range` and `If-Range` supported; multi-range (`multipart/byteranges`) supported
- **Gzip** - compressible MIME types are compressed when the client sends `Accept-Encoding: gzip`
- **Content-Disposition** - binary/archive types are served with `attachment` so browsers download rather than render
- **TLS** - pass `key`/`cert` as file paths or pre-loaded `Buffer`s to switch to `https.createServer`
- **Clustering** - `serve()` guarantees user code never runs in the primary; primary supervises a worker and restarts it after 500 ms on unexpected exit; clean signal exits are not restarted
- **Graceful shutdown** - idle connections closed immediately; active connections given a 5 s grace period before forced termination
- **DevTools** - serves `/.well-known/appspecific/com.chrome.devtools.json` with a per-process UUID to register the root as a Chrome DevTools workspace
- **WebSocket-friendly** - `server.server` exposes the underlying `http.Server` / `https.Server` for attaching WebSocket libraries
- **Query params** - `req.query` populated on every request; repeated keys collapse to `string[]`, single-occurrence keys remain `string`
- **Body parsing** - opt-in `createBodyParser()` middleware; supports `application/json` and `application/x-www-form-urlencoded`; configurable byte limit (default 1 MiB); populates `req.body`
- **Response helpers** - `res.json(data, status?)` and `res.html(markup, status?)` set correct `Content-Type` and `Content-Length` automatically
- **TypeScript** - typings generated and bundled
- **npm** - no runtime npm dependencies; requires Node.js 22+
- **Security** - path traversal → `400`; URLs > 2048 bytes → `414`; > 50 headers → `431`; unmatched non-GET/HEAD → `405` with accurate `Allow` header
