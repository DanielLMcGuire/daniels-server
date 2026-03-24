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
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '#server/types';

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
    /** 
     * Enable Chrome DevTools workspace integration. Default: `false`. 
     * https://developer.chrome.com/docs/devtools/workspaces/?utm_source=devtools
     * */
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

    type HandlerEntry = { mountPath: string | null; handler: RequestHandler };
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
            if (entry.mountPath === null || urlMatchesMount(req.url, entry.mountPath)) break;
            index++;
        }

        if (index >= handlerEntries.length) {
            await serveStatic(req, res);
            return;
        }

        const { handler } = handlerEntries[index];
        await handler(req, res, (err?: unknown) => {
            if (err !== undefined) return Promise.reject(err);
            return runHandlers(req, res, index + 1);
        });
    }

    const httpServer = useTls
        ? https.createServer(tlsContext!, async (req, res) => handleRequest(req, res))
        : http.createServer(async (req, res) => handleRequest(req, res));

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = req.method ?? 'GET';

        if (logging) console.log(`Client: ${req.method} ${req.url}`);

        if (method !== 'GET' && method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' });
            res.end();
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

    httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
    httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
    let isListening = false;

    const instance: ServerInstance = {
        get root()      { return ROOT; },
        get port()      { return port; },
        get listening() { return isListening; },
        get server()    { return httpServer; },

        use(pathOrHandler: string | RequestHandler, maybeHandler?: RequestHandler): ServerInstance {
            if (typeof pathOrHandler === 'function') {
                handlerEntries.push({ mountPath: null, handler: pathOrHandler });
            } else {
                if (!maybeHandler) throw new TypeError('use(path, handler): handler is required');
                handlerEntries.push({
                    mountPath: normaliseMountPath(pathOrHandler),
                    handler:   maybeHandler,
                });
            }
            return instance;
        },

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
