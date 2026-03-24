import type http  from 'http';
import type https from 'https';
import type { RequestHandler } from '#zorvix/router';

export type { NextFunction, RequestHandler } from '#zorvix/router';

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
    use(handler: RequestHandler): this;

    /**
     * Register a path-prefixed request handler.  The handler is only invoked
     * when the request URL starts with `mountPath`.  `req.url` is **not**
     * rewritten — the full URL is always visible to the handler.
     * Returns `this` for chaining.
     */
    use(mountPath: string, handler: RequestHandler): this;

    /** Register a handler for GET `routePath`. */
    get(routePath: string,     handler: RequestHandler): this;
    /** Register a handler for POST `routePath`. */
    post(routePath: string,    handler: RequestHandler): this;
    /** Register a handler for PUT `routePath`. */
    put(routePath: string,     handler: RequestHandler): this;
    /** Register a handler for PATCH `routePath`. */
    patch(routePath: string,   handler: RequestHandler): this;
    /** Register a handler for DELETE `routePath`. */
    delete(routePath: string,  handler: RequestHandler): this;
    /** Register a handler for HEAD `routePath`. */
    head(routePath: string,    handler: RequestHandler): this;
    /** Register a handler for OPTIONS `routePath`. */
    options(routePath: string, handler: RequestHandler): this;

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
