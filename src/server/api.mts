import http                               from 'http';
import https                              from 'https';
import crypto                             from 'crypto';
import path                               from 'path';
import cluster                            from 'cluster';
import { IncomingMessage, ServerResponse } from 'http';
import { createCache }                    from '#zorvix/cache';
import { createDevToolsHandler }          from '#zorvix/devtools';
import { createRouter, normaliseMountPath } from '#zorvix/router';
import { createStaticHandler }            from '#zorvix/static';
import { createLoggingMiddleware, createGuardMiddleware } from '#zorvix/middleware';
import { createPrimaryInstance }          from '#zorvix/cluster';
import { resolvePem }                     from '#zorvix/tls';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_HEADERS_COUNT, SHUTDOWN_GRACE_MS } from '#zorvix/internal-types';
import type { ServerOptions, ServerInstance, RequestHandler } from '#zorvix/api-types';


/**
 * Creates and configures a Zorvix HTTP or HTTPS server.
 *
 * Handles static file serving, request routing, optional TLS, cluster worker
 * spawning, an in-memory file cache, and an optional DevTools endpoint.
 *
 * @example
 * ```ts
 * const server = createServer({ port: 3000, logging: true });
 *
 * server.get('/hello', (req, res) => {
 *     res.end('Hello, world!');
 * });
 *
 * await server.start();
 * ```
 *
 * @example TLS
 * ```ts
 * const server = createServer({
 *     port: 443,
 *     key:  './certs/server.key',
 *     cert: './certs/server.crt',
 * });
 * ```
 *
 * @example Cluster mode
 * ```ts
 * // The primary process forks workers automatically; each worker calls
 * // createServer() again and reaches the non-primary branch.
 * const server = createServer({ port: 3000, workers: true });
 * ```
 *
 * @param options - Configuration options for the server.
 * @returns A {@link ServerInstance} that exposes route registration and
 *   lifecycle methods. When `workers` is `true` and the process is the
 *   cluster primary, a lightweight primary-only instance is returned instead.
 */
export function createServer(options: ServerOptions): ServerInstance {
    const { port, logging = false, devTools = false, workers = false } = options;
    const root = options.root ? path.resolve(options.root) : process.cwd();

    // In cluster mode the primary process only manages workers — it does not
    // set up a router or bind a socket itself.
    if (workers && cluster.isPrimary) {
        return createPrimaryInstance(port, root);
    }

    const useTls = !!(options.key && options.cert);
    const tlsContext = useTls
        ? { key: resolvePem(options.key!), cert: resolvePem(options.cert!) }
        : undefined;

    const { getFile, startPruning } = createCache(root, logging);

    /** Randomly-generated UUID that scopes the DevTools endpoint, preventing accidental exposure. */
    const devToolsUUID   = devTools ? crypto.randomUUID() : null;
    const handleDevTools = devToolsUUID
        ? createDevToolsHandler(root, devToolsUUID, logging)
        : null;

    const serveStatic = createStaticHandler(root, getFile, handleDevTools, logging);
    const router = createRouter(logging);

    // Global middleware — logging runs first, then the security guard.
    if (logging) router.addMiddleware(null, createLoggingMiddleware());
    router.addMiddleware(null, createGuardMiddleware(logging));

    const httpServer = useTls
        ? https.createServer(tlsContext!, handleRequest)
        : http.createServer(handleRequest);

    // Apply conservative timeouts and header limits to reduce exposure to
    // slow-loris and header-overflow attacks.
    httpServer.headersTimeout  = HEADERS_TIMEOUT_MS;
    httpServer.requestTimeout  = REQUEST_TIMEOUT_MS;
    httpServer.maxHeadersCount = MAX_HEADERS_COUNT;

    /**
     * Top-level request handler wired directly into the underlying Node.js
     * `http`/`https` server. Initialises per-request state, delegates to the
     * router (which falls back to static-file serving), and catches any
     * unhandled errors so the process never crashes on a single bad request.
     *
     * @param req - The incoming HTTP request.
     * @param res - The outgoing HTTP response.
     */
    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        req.params = {};
        try {
            await router.dispatch(req, res, serveStatic);
        } catch (err) {
            console.error('Server: Unhandled error in request handler:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
            }
        }
    }

    /** Tracks whether the underlying socket is currently bound and accepting connections. */
    let isListening = false;

    /**
     * Registers a route with the given HTTP method and returns the server
     * instance for chaining.
     *
     * @param method  - HTTP method string (e.g. `'GET'`).
     * @param routePath - URL pattern, which may include named parameters (e.g. `'/users/:id'`).
     * @param handler - Request handler invoked when the route is matched.
     * @returns The current {@link ServerInstance}.
     */
    function addRoute(method: string, routePath: string, handler: RequestHandler): ServerInstance {
        router.addRoute(method, routePath, handler);
        return instance;
    }

    const instance: ServerInstance = {
        /** Absolute path to the static-file root directory. */
        get root()      { return root; },

        /** TCP port the server will bind to (or is already bound to). */
        get port()      { return port; },

        /** `true` while the server is bound and accepting incoming connections. */
        get listening() { return isListening; },

        /** The underlying Node.js `http.Server` or `https.Server` instance. */
        get server()    { return httpServer; },

        /**
         * Registers a middleware function, optionally scoped to a path prefix.
         *
         * @example Global middleware
         * ```ts
         * server.use((req, res, next) => { console.log(req.url); next(); });
         * ```
         *
         * @example Path-scoped middleware
         * ```ts
         * server.use('/api', authMiddleware);
         * ```
         *
         * @param pathOrHandler - Either a path prefix string or a global middleware function.
         * @param maybeHandler  - Required when `pathOrHandler` is a string.
         * @returns The current {@link ServerInstance} for chaining.
         * @throws {TypeError} When a path is provided without a corresponding handler.
         */
        use(pathOrHandler: string | RequestHandler, maybeHandler?: RequestHandler): ServerInstance {
            if (typeof pathOrHandler === 'function') {
                router.addMiddleware(null, pathOrHandler);
            } else {
                if (!maybeHandler) throw new TypeError('use(path, handler): handler is required');
                router.addMiddleware(normaliseMountPath(pathOrHandler), maybeHandler);
            }
            return instance;
        },

        /**
         * Registers a `GET` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        get    (routePath, handler) { return addRoute('GET',     routePath, handler); },

        /**
         * Registers a `POST` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        post   (routePath, handler) { return addRoute('POST',    routePath, handler); },

        /**
         * Registers a `PUT` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        put    (routePath, handler) { return addRoute('PUT',     routePath, handler); },

        /**
         * Registers a `PATCH` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        patch  (routePath, handler) { return addRoute('PATCH',   routePath, handler); },

        /**
         * Registers a `DELETE` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        delete (routePath, handler) { return addRoute('DELETE',  routePath, handler); },

        /**
         * Registers a `HEAD` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        head   (routePath, handler) { return addRoute('HEAD',    routePath, handler); },

        /**
         * Registers an `OPTIONS` route.
         * @param routePath - URL pattern to match.
         * @param handler   - Handler invoked on a match.
         * @returns The current {@link ServerInstance} for chaining.
         */
        options(routePath, handler) { return addRoute('OPTIONS', routePath, handler); },

        /**
         * Binds the server to the configured port and begins accepting connections.
         * Also starts the cache-pruning interval.
         *
         * @returns A promise that resolves once the server is listening, or
         *   rejects if the port cannot be bound.
         * @throws {Error} If the server is already listening.
         */
        start(): Promise<void> {
            if (isListening) return Promise.reject(new Error('Server is already listening'));
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, () => {
                    httpServer.off('error', reject);
                    isListening = true;
                    startPruning();
                    const protocol    = useTls ? 'https' : 'http';
                    const defaultPort = useTls ? 443 : 80;
                    console.log(
                        port !== defaultPort
                            ? `Server running at ${protocol}://localhost:${port}/`
                            : `Server running at ${protocol}://localhost/`,
                    );
                    resolve();
                });
            });
        },

        /**
         * Gracefully stops the server by closing the socket and draining
         * existing connections.
         *
         * Idle connections are closed immediately; active connections are given
         * {@link SHUTDOWN_GRACE_MS} milliseconds to finish before being forcibly
         * terminated.
         *
         * @returns A promise that resolves once the server has fully stopped.
         *   Resolves immediately if the server is not currently listening.
         */
        stop(): Promise<void> {
            if (!isListening) return Promise.resolve();
            isListening = false;
            return new Promise((resolve, reject) => {
                httpServer.close((err) => {
                    if (err) { reject(err); return; }
                    resolve();
                });

                httpServer.closeIdleConnections();

                setTimeout(
                    () => httpServer.closeAllConnections(),
                    SHUTDOWN_GRACE_MS,
                ).unref();
            });
        },
    };

    return instance;
}