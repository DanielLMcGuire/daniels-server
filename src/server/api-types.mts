import type * as http from 'node:http';
import type * as https from 'node:https';
import type { RequestHandler } from '#zorvix/router';

export type { NextFunction, RequestHandler } from '#zorvix/router';

declare module 'node:http' {
    interface IncomingMessage {
        /** Route parameters extracted from the matched URL pattern (e.g. `{ id: '42' }` for `/users/:id`). */
        params: Record<string, string>;
        /** Parsed request body, populated by body-parsing middleware. `unknown` until narrowed by the caller. */
        body?: unknown;
        /**
         * Parsed query-string parameters from the request URL.
         * Multi-value keys (e.g. `?tag=a&tag=b`) are collected into an array;
         * single-value keys produce a plain string.
         *
         * Always present — populated before the first middleware runs.
         *
         * @example
         * // GET /search?q=hello&tag=a&tag=b
         * req.query  // → { q: 'hello', tag: ['a', 'b'] }
         */
        query: Record<string, string | string[]>;
    }
    interface ServerResponse {
        /**
         * Serialize `data` as JSON and send a complete response.
         * Sets `Content-Type: application/json` and `Content-Length` automatically.
         *
         * @param data   - Any JSON-serialisable value.
         * @param status - HTTP status code (default `200`).
         *
         * @example
         * res.json({ ok: true });
         * res.json({ error: 'Not found' }, 404);
         */
        json(data: unknown, status?: number): void;
        /**
         * Send an HTML string as a complete response.
         * Sets `Content-Type: text/html; charset=utf-8` and `Content-Length` automatically.
         *
         * @param markup - UTF-8 HTML string.
         * @param status - HTTP status code (default `200`).
         *
         * @example
         * res.html('<h1>Hello</h1>');
         * res.html('<p>Not found</p>', 404);
         */
        html(markup: string, status?: number): void;
    }
}

export interface ServerOptions {
    /** Port to listen on. */
    port:      number;
    /**
     * Directory to serve files from.
     * Defaults to `process.cwd()`.
     */
    root?:     string;
    /** Log requests and cache activity to stdout. Default: `false`. */
    logging?:  boolean;
    /** Enable Chrome DevTools workspace integration. Default: `false`. */
    devTools?: boolean;
    /**
     * Fork a cluster worker and supervise it.  When `true` and the current
     * process is the cluster primary, `start()` forks one worker and restarts
     * it on unexpected exit.  The worker re-executes the same entry-point,
     * hits `createServer` again, and this time runs as the HTTP server.
     * Default: `false`.
     */
    workers?:  boolean;
    /**
     * Enable the in-memory file cache.  When `false` every static-file request
     * is served directly from disk with no caching or cache pruning.  Useful
     * in dev / devtools mode where files change frequently and stale cache
     * entries would mask updates.
     * Default: `true`.
     */
    cache?:    boolean;
    /**
     * PEM-encoded TLS private key — either a file-system path (string) or the
     * key material itself (Buffer).  Must be supplied together with `cert` to
     * enable HTTPS.
     */
    key?:      string | Buffer;
    /**
     * PEM-encoded TLS certificate — either a file-system path (string) or the
     * certificate material itself (Buffer).  Must be supplied together with
     * `key` to enable HTTPS.
     */
    cert?:     string | Buffer;
}

export interface ServerInstance {
    /**
     * Register a request handler that runs *before* static-file serving.
     * Handlers are called in registration order; call `next()` to continue
     * the chain.  Passing an error to `next(err)` aborts the chain and
     * propagates the error to the top-level error handler.
     * Returns `this` for chaining.
     */
    use(handler: RequestHandler): ServerInstance;
    use(path: string, handler: RequestHandler): ServerInstance;

    /** Register a handler for GET `routePath`. */
    get(routePath: string,     handler: RequestHandler): ServerInstance;
    /** Register a handler for POST `routePath`. */
    post(routePath: string,    handler: RequestHandler): ServerInstance;
    /** Register a handler for PUT `routePath`. */
    put(routePath: string,     handler: RequestHandler): ServerInstance;
    /** Register a handler for PATCH `routePath`. */
    patch(routePath: string,   handler: RequestHandler): ServerInstance;
    /** Register a handler for DELETE `routePath`. */
    delete(routePath: string,  handler: RequestHandler): ServerInstance;
    /** Register a handler for HEAD `routePath`. */
    head(routePath: string,    handler: RequestHandler): ServerInstance;
    /** Register a handler for OPTIONS `routePath`. */
    options(routePath: string, handler: RequestHandler): ServerInstance;

    /**
     * Start listening.  Resolves once the server is bound and ready to accept
     * connections.  Rejects if the server is already listening, if the port is
     * already in use, or if another OS error occurs.
     *
     * In the cluster primary, resolves once the worker process has been forked.
     */
    start(): Promise<void>;

    /**
     * Gracefully stop the server.  Resolves immediately when the server is not
     * currently listening, otherwise waits until all in-flight connections are
     * closed.
     *
     * In the cluster primary, sends SIGINT to the worker and resolves once it
     * exits.
     */
    stop(): Promise<void>;

    /** The resolved absolute path being served. */
    readonly root:      string;
    /** The port passed to `createServer`. */
    readonly port:      number;
    /** `true` between a successful `start()` and the completion of `stop()`. */
    readonly listening: boolean;
    /**
     * The underlying `http.Server` or `https.Server` instance.
     * Throws if accessed from the cluster primary process.
     */
    readonly server:    http.Server | https.Server;
}

/**
 * Cluster-safe application entrypoint.
 *
 * When `workers` is `true` and the current process is the cluster primary,
 * the primary forks and supervises a worker without ever invoking `setup` —
 * so no user code (DB connections, route registration, etc.) runs in the
 * primary process.  In all other cases (single-process or inside a worker)
 * `setup` is called immediately with a fully configured {@link ServerInstance}.
 *
 * Use this instead of {@link createServer} when `workers: true`.  For tests
 * and single-process usage {@link createServer} remains the right choice.
 *
 * @param options - Configuration options for the server.
 * @param setup   - Callback invoked with the configured {@link ServerInstance}
 *   in every process except the cluster primary.  Call `server.start()` inside
 *   the callback to begin accepting connections.
 *
 * @example
 * ```ts
 * serve({ port: 3000, workers: true }, async (server) => {
 *     await db.connect();
 *     server.get('/users', async (req, res) => {
 *         res.json(await db.query('SELECT * FROM users'));
 *     });
 *     await server.start();
 * });
 * ```
 */
export declare function serve(
    options: ServerOptions,
    setup:   (server: ServerInstance) => void | Promise<void>,
): void | Promise<void>;
