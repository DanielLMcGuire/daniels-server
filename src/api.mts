import http              from 'http';
import https             from 'https';
import fs                from 'fs';
import crypto            from 'crypto';
import path              from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { createCache }   from '#server/cache';
import { createDevToolsHandler } from '#server/devtools';
import { serveBufferFile, serveStreamFile } from '#server/serve';
import { isAttachment, cacheControlFor }    from '#server/mime';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_HEADERS_COUNT, MAX_URL_LENGTH } from '#server/types';

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

function resolveFilePath(url: string | undefined, root: string): string | null {
    const raw = !url || url === '/' ? '/index.html' : url.split('?')[0];

    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }

    const resolved = path.resolve(root, '.' + decoded);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
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

    const useTls = !!(options.key && options.cert);
    let tlsContext: { key: Buffer; cert: Buffer } | undefined;
    if (useTls) {
        tlsContext = {
            key:  resolvePem(options.key!),
            cert: resolvePem(options.cert!),
        };
    }

    async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = req.method ?? 'GET';

        if (handleDevTools &&
            req.url?.split('?')[0].endsWith('/.well-known/appspecific/com.chrome.devtools.json')) {
            handleDevTools(req, res, method);
            return;
        }

        const filepath = resolveFilePath(req.url, ROOT);

        if (!filepath) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('400 Bad Request');
            if (logging) console.log(`Server: 400 (traversal/bad URL) ${req.url}`);
            return;
        }

        const fileData = await getFile(filepath);

        if (!fileData) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            if (logging) console.log(`Server: 404 ${req.url}`);
            return;
        }

        if (logging) console.log(`Server: Serving ${path.relative(ROOT, filepath)}`);

        const ext            = path.extname(filepath);
        const clientEtag     = req.headers['if-none-match'];
        const clientModified = req.headers['if-modified-since'];

        const etagMatch     = clientEtag && clientEtag === fileData.etag;
        const modifiedMatch = !clientEtag && clientModified &&
            new Date(clientModified) >= new Date(fileData.lastModified);

        if (etagMatch || modifiedMatch) {
            res.writeHead(304, {
                'ETag':          fileData.etag,
                'Last-Modified': fileData.lastModified,
                'Cache-Control': cacheControlFor(ext),
            });
            res.end();
            if (logging) console.log(`Server: 304 ${req.url}`);
            return;
        }

        const baseHeaders: Record<string, string | number> = {
            'Content-Type':  fileData.contentType,
            'ETag':          fileData.etag,
            'Last-Modified': fileData.lastModified,
            'Cache-Control': cacheControlFor(ext),
            'Accept-Ranges': 'bytes',
        };

        if (isAttachment(ext)) {
            const filename = encodeURIComponent(path.basename(filepath));
            baseHeaders['Content-Disposition'] =
                `attachment; filename="${filename}"; filename*=UTF-8''${filename}`;
        }

        const rangeHeader = req.headers['range'];
        const ifRange     = req.headers['if-range'];
        const honorRange  = !!rangeHeader && (!ifRange || ifRange === fileData.etag);
        const acceptsGzip = req.headers['accept-encoding']?.includes('gzip') ?? false;

        if ('buffer' in fileData) {
            serveBufferFile(req, res, fileData, baseHeaders, method,
                rangeHeader, honorRange, acceptsGzip, logging);
        } else {
            serveStreamFile(req, res, fileData, baseHeaders, method, ext,
                rangeHeader, honorRange, acceptsGzip, logging, ROOT);
        }
    }

    async function runHandlers(
        req:   IncomingMessage,
        res:   ServerResponse,
        index: number,
    ): Promise<void> {
        while (index < handlerEntries.length) {
            const entry = handlerEntries[index];

            if (entry.kind === 'middleware') {
                if (entry.mountPath === null || urlMatchesMount(req.url, entry.mountPath)) break;
            } else {
                if (entry.method === (req.method ?? 'GET').toUpperCase()) {
                    const params = matchRoute(req.url, entry.regex, entry.paramNames);
                    if (params !== null) {
                        req.params = params;
                        break;
                    }
                }
            }

            index++;
        }

        if (index >= handlerEntries.length) {
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
            return;
        }

        const { handler } = handlerEntries[index];
        await handler(req, res, (err?: unknown) => {
            if (err !== undefined) return Promise.reject(err);
            if (res.writableEnded) return Promise.resolve();
            return runHandlers(req, res, index + 1);
        });
    }

    const httpServer = useTls
        ? https.createServer(tlsContext!, (req, res) => handleRequest(req, res))
        : http.createServer((req, res) => handleRequest(req, res));

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        req.params = {};

        if (logging) console.log(`Client: ${req.method} ${req.url}`);

        if ((req.url?.length ?? 0) > MAX_URL_LENGTH) {
            res.writeHead(414, { 'Content-Type': 'text/plain' });
            res.end('414 URI Too Long');
            if (logging) console.log(`Server: 414 (URL too long: ${req.url?.length} bytes) ${req.url?.slice(0, 80)}…`);
            return;
        }

        if (Object.keys(req.headers).length > MAX_HEADERS_COUNT) {
            res.writeHead(431, { 'Content-Type': 'text/plain' });
            res.end('431 Request Header Fields Too Large');
            if (logging) console.log(`Server: 431 (${Object.keys(req.headers).length} headers) ${req.url}`);
            return;
        }

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
                if (!maybeHandler) throw new TypeError('use(path, handler): handler is required');
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
            });
        },
    };

    return instance;
}
