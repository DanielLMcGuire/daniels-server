import http              from 'http';
import https             from 'https';
import fs                from 'fs';
import crypto            from 'crypto';
import path              from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { createCache }              from '#zorvix/cache';
import { createDevToolsHandler }    from '#zorvix/devtools';
import { rejectRequest, createStaticHandler } from '#zorvix/static';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_HEADERS_COUNT } from '#zorvix/types';

declare module 'http' {
    interface IncomingMessage {
        params: Record<string, string>;
    }
}

/**
 * Optional error value passed to `next()`.  When present the chain is aborted
 * and the error is re-thrown so the top-level try/catch can handle it.
 */
export type NextFunction = (err?: unknown) => void | Promise<void>;

export type RequestHandler = (
    req:  IncomingMessage,
    res:  ServerResponse,
    next: NextFunction,
) => void | Promise<void>;

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
    get(routePath: string, handler: RequestHandler): this;
    /** Register a handler for POST `routePath`. */
    post(routePath: string, handler: RequestHandler): this;
    /** Register a handler for PUT `routePath`. */
    put(routePath: string, handler: RequestHandler): this;
    /** Register a handler for PATCH `routePath`. */
    patch(routePath: string, handler: RequestHandler): this;
    /** Register a handler for DELETE `routePath`. */
    delete(routePath: string, handler: RequestHandler): this;
    /** Register a handler for HEAD `routePath`. */
    head(routePath: string, handler: RequestHandler): this;
    /** Register a handler for OPTIONS `routePath`. */
    options(routePath: string, handler: RequestHandler): this;

    /**
     * Start listening.  Resolves once the server is bound and ready to accept
     * connections.  Rejects if the server is already listening, if the port is
     * already in use, or if another OS error occurs.
     */
    start(): Promise<void>;

    /**
     * Gracefully stop the server.  Resolves immediately when the server is not
     * currently listening, otherwise waits until all in-flight connections are
     * closed.
     */
    stop(): Promise<void>;

    /** The resolved absolute path being served. */
    readonly root:      string;
    /** The port passed to `createServer`. */
    readonly port:      number;
    /** `true` between a successful `start()` and the completion of `stop()`. */
    readonly listening: boolean;
    /** The underlying `http.Server` or `https.Server` instance, in case you need low-level access. */
    readonly server:    http.Server | https.Server;
}

type MiddlewareEntry = {
    kind:      'middleware';
    mountPath: string | null;
    handler:   RequestHandler;
};

type RouteEntry = {
    kind:       'route';
    method:     string;
    regex:      RegExp;
    paramNames: string[];
    handler:    RequestHandler;
};

type HandlerEntry = MiddlewareEntry | RouteEntry;

/**
 * Compile an Express-style route path into a RegExp + param name list.
 *
 * Supported syntax:
 *   :name   — captures one path segment (no slashes)
 *   *       — captures everything (including slashes)
 */
function compilePattern(routePath: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    let src = routePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    src = src.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_full, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
    });

    let wildcardIdx = 0;
    src = src.replace(/\*/g, () => {
        paramNames.push(String(wildcardIdx++));
        return '(.*)';
    });

    return { regex: new RegExp(`^${src}$`), paramNames };
}

/**
 * Test a request URL against a compiled route pattern.
 * Returns extracted params on match, `null` on miss.
 */
function matchRoute(
    reqUrl:     string | undefined,
    regex:      RegExp,
    paramNames: string[],
): Record<string, string> | null {
    const reqPath = (reqUrl ?? '/').split('?')[0];
    const m = regex.exec(reqPath);
    if (!m) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
        try {
            params[paramNames[i]] = decodeURIComponent(m[i + 1]);
        } catch {
            params[paramNames[i]] = m[i + 1];
        }
    }
    return params;
}

/**
 * Collect every HTTP method that has a registered route whose pattern matches
 * `reqUrl`.  Used to populate the `Allow` header on 405 responses.
 */
function allowedMethodsFor(reqUrl: string | undefined, entries: HandlerEntry[]): string {
    const methods = new Set<string>(['GET', 'HEAD']);
    for (const entry of entries) {
        if (entry.kind !== 'route') continue;
        if (matchRoute(reqUrl, entry.regex, entry.paramNames) !== null) {
            methods.add(entry.method);
            if (entry.method === 'GET') methods.add('HEAD');
        }
    }
    return [...methods].sort().join(', ');
}

function normaliseMountPath(p: string): string {
    const withLeading = p.startsWith('/') ? p : '/' + p;
    return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
}

function urlMatchesMount(reqUrl: string | undefined, mountPath: string): boolean {
    const reqPath = (reqUrl ?? '/').split('?')[0];
    return reqPath === mountPath || reqPath.startsWith(mountPath + '/');
}

function resolvePem(value: string | Buffer): Buffer {
    return Buffer.isBuffer(value) ? value : fs.readFileSync(value);
}

export function createServer(options: ServerOptions): ServerInstance {
    const { port, logging = false, devTools = false } = options;
    const ROOT = options.root ? path.resolve(options.root) : process.cwd();

    const handlerEntries: HandlerEntry[] = [];

    const { getFile, startPruning } = createCache(ROOT, logging);

    const devToolsUUID   = devTools ? crypto.randomUUID() : null;
    const handleDevTools = devToolsUUID
        ? createDevToolsHandler(ROOT, devToolsUUID, logging)
        : null;

    const serveStatic = createStaticHandler(ROOT, getFile, handleDevTools, logging);

    const useTls = !!(options.key && options.cert);
    let tlsContext: { key: Buffer; cert: Buffer } | undefined;
    if (useTls) {
        tlsContext = {
            key:  resolvePem(options.key!),
            cert: resolvePem(options.cert!),
        };
    }

    async function runHandlers(
        req:   IncomingMessage,
        res:   ServerResponse,
        index: number,
    ): Promise<void> {
        while (index < handlerEntries.length) {
            const entry = handlerEntries[index];

            let matches = false;
            if (entry.kind === 'middleware') {
                matches = entry.mountPath === null || urlMatchesMount(req.url, entry.mountPath);
            } else if (entry.method === (req.method ?? 'GET').toUpperCase()) {
                const params = matchRoute(req.url, entry.regex, entry.paramNames);
                if (params !== null) {
                    req.params = params;
                    matches = true;
                }
            }

            if (!matches) { index++; continue; }

            await entry.handler(req, res, (err?: unknown) => {
                if (err !== undefined) return Promise.reject(err);
                if (res.writableEnded) return Promise.resolve();
                return runHandlers(req, res, index + 1);
            });
            return;
        }

        if (res.writableEnded) return;

        const method = req.method ?? 'GET';
        if (method === 'GET' || method === 'HEAD') {
            await serveStatic(req, res);
        } else {
            const allow = allowedMethodsFor(req.url, handlerEntries);
            res.writeHead(405, { Allow: allow, 'Content-Type': 'text/plain' });
            res.end('405 Method Not Allowed');
            if (logging) console.log(`Server: 405 ${method} ${req.url}`);
        }
    }

    const httpServer = useTls
        ? https.createServer(tlsContext!, (req, res) => handleRequest(req, res))
        : http.createServer((req, res) => handleRequest(req, res));

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        req.params = {};

        if (logging) console.log(`Client: ${req.method} ${req.url}`);

        if (rejectRequest(req, res, logging)) return;

        try {
            await runHandlers(req, res, 0);
        } catch (err) {
            console.error('Server: Unhandled error in request handler:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('500 Internal Server Error');
            }
        }
    }

    httpServer.headersTimeout  = HEADERS_TIMEOUT_MS;
    httpServer.requestTimeout  = REQUEST_TIMEOUT_MS;
    httpServer.maxHeadersCount = MAX_HEADERS_COUNT;

    let isListening = false;

    function addRoute(method: string, routePath: string, handler: RequestHandler): ServerInstance {
        const { regex, paramNames } = compilePattern(routePath);
        handlerEntries.push({ kind: 'route', method: method.toUpperCase(), regex, paramNames, handler });
        return instance;
    }

    const instance: ServerInstance = {
        get root()      { return ROOT; },
        get port()      { return port; },
        get listening() { return isListening; },
        get server()    { return httpServer; },

        // Middleware
        use(pathOrHandler: string | RequestHandler, maybeHandler?: RequestHandler): ServerInstance {
            if (typeof pathOrHandler === 'function') {
                handlerEntries.push({ kind: 'middleware', mountPath: null, handler: pathOrHandler });
            } else {
                if (!maybeHandler) throw new TypeError(
`use("${pathOrHandler}", handler): expected a handler function as the second argument, got ${typeof maybeHandler}`
                );
                handlerEntries.push({
                    kind:      'middleware',
                    mountPath: normaliseMountPath(pathOrHandler),
                    handler:   maybeHandler,
                });
            }
            return instance;
        },

        // REST
        get    (routePath, handler) { return addRoute('GET',     routePath, handler); },
        post   (routePath, handler) { return addRoute('POST',    routePath, handler); },
        put    (routePath, handler) { return addRoute('PUT',     routePath, handler); },
        patch  (routePath, handler) { return addRoute('PATCH',   routePath, handler); },
        delete (routePath, handler) { return addRoute('DELETE',  routePath, handler); },
        head   (routePath, handler) { return addRoute('HEAD',    routePath, handler); },
        options(routePath, handler) { return addRoute('OPTIONS', routePath, handler); },

        start(): Promise<void> {
            if (isListening) {
                return Promise.reject(new Error('Server is already listening'));
            }
            return new Promise((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(port, () => {
                    httpServer.off('error', reject);
                    isListening = true;
                    startPruning();
                    if (logging) {
                        const protocol    = useTls ? 'https' : 'http';
                        const defaultPort = useTls ? 443 : 80;
                        console.log(
                            port !== defaultPort
                                ? `Server running at ${protocol}://localhost:${port}/`
                                : `Server running at ${protocol}://localhost/`
                        );
                    }
                    resolve();
                });
            });
        },

        stop(): Promise<void> {
            if (!isListening) return Promise.resolve();
            return new Promise((resolve, reject) => {
                httpServer.close((err) => {
                    if (err) { reject(err); return; }
                    isListening = false;
                    resolve();
                });
                httpServer.closeAllConnections();
            });
        },
    };

    return instance;
}
