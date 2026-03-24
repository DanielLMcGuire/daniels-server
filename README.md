# daniels-server

A zero-dependency Node.js static file server with support for clustering, TLS, HTTP caching, range requests, gzip, and Chrome DevTools workspace integration.

---

## Usage

```bash
# install build time deps
npm install 
# typecheck, compile ts, pack
npm run build
# run
node dist/server.min.js <port> [options]
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
node server.js 8080

# Serve a specific directory with request logging
node server.js 3000 --root ./dist -l

# HTTPS
node server.js 443 --key ./key.pem --cert ./cert.pem

# Dev mode with DevTools workspace
node server.js 8080 --dev --devtools -l
```

---

## API

`api.mts` exports `createServer()` for embedding the server in your own code.

```ts
import { createServer } from './api.mts';

const server = createServer({ port: 8080, root: './dist', logging: true });

// Register middleware (runs before static file serving)
server.use((req, res, next) => {
    res.setHeader('X-Custom-Header', 'hello');
    next();
});

// Mount a handler at a path prefix
server.use('/api', (req, res, next) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
});

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
| `.start()` | Start listening, resolves when ready |
| `.stop()` | Gracefully stop the server |
| `.root` | Resolved absolute path being served |
| `.port` | Port number |
| `.listening` | `true` while the server is active |
| `.server` | The underlying `http.Server` / `https.Server` |

---

## Features

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
- Only `GET` and `HEAD` methods are accepted; all others return `405 Method Not Allowed`.