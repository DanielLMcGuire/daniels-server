import http              from 'http';
import https             from 'https';
import fs                from 'fs';
import crypto            from 'crypto';
import path              from 'path';
import { IncomingMessage, ServerResponse }    from 'http';
import { createCache }                        from '#zorvix/cache';
import { createDevToolsHandler }              from '#zorvix/devtools';
import { rejectRequest, createStaticHandler } from '#zorvix/static';
import { createRouter, normaliseMountPath }   from '#zorvix/router';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_HEADERS_COUNT } from '#zorvix/types';
import type { ServerOptions, ServerInstance } from '#zorvix/api-types';
import type { RequestHandler }                from '#zorvix/router';

export type { NextFunction, RequestHandler, ServerOptions, ServerInstance } from '#zorvix/api-types';

declare module 'http' {
    interface IncomingMessage {
        params: Record<string, string>;
    }
}

function resolvePem(value: string | Buffer): Buffer {
    return Buffer.isBuffer(value) ? value : fs.readFileSync(value);
}

export function createServer(options: ServerOptions): ServerInstance {
    const { port, logging = false, devTools = false } = options;
    const ROOT = options.root ? path.resolve(options.root) : process.cwd();

    const { getFile, startPruning } = createCache(ROOT, logging);

    const devToolsUUID   = devTools ? crypto.randomUUID() : null;
    const handleDevTools = devToolsUUID
        ? createDevToolsHandler(ROOT, devToolsUUID, logging)
        : null;

    const serveStatic = createStaticHandler(ROOT, getFile, handleDevTools, logging);
    const router      = createRouter(logging);

    const useTls = !!(options.key && options.cert);
    let tlsContext: { key: Buffer; cert: Buffer } | undefined;
    if (useTls) {
        tlsContext = {
            key:  resolvePem(options.key!),
            cert: resolvePem(options.cert!),
        };
    }

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        req.params = {};
        if (logging) console.log(`Client: ${req.method} ${req.url}`);
        if (rejectRequest(req, res, logging)) return;
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

    const httpServer = useTls
        ? https.createServer(tlsContext!, handleRequest)
        : http.createServer(handleRequest);

    httpServer.headersTimeout  = HEADERS_TIMEOUT_MS;
    httpServer.requestTimeout  = REQUEST_TIMEOUT_MS;
    httpServer.maxHeadersCount = MAX_HEADERS_COUNT;

    let isListening = false;

    const instance: ServerInstance = {
        get root()      { return ROOT; },
        get port()      { return port; },
        get listening() { return isListening; },
        get server()    { return httpServer; },

        use(pathOrHandler: string | RequestHandler, maybeHandler?: RequestHandler): ServerInstance {
            if (typeof pathOrHandler === 'function') {
                router.addMiddleware(null, pathOrHandler);
            } else {
                if (!maybeHandler) throw new TypeError(
                    `use("${pathOrHandler}", handler): expected a handler function as the second argument, got ${typeof maybeHandler}`
                );
                router.addMiddleware(normaliseMountPath(pathOrHandler), maybeHandler);
            }
            return instance;
        },

        get    (routePath, handler) { router.addRoute('GET',     routePath, handler); return instance; },
        post   (routePath, handler) { router.addRoute('POST',    routePath, handler); return instance; },
        put    (routePath, handler) { router.addRoute('PUT',     routePath, handler); return instance; },
        patch  (routePath, handler) { router.addRoute('PATCH',   routePath, handler); return instance; },
        delete (routePath, handler) { router.addRoute('DELETE',  routePath, handler); return instance; },
        head   (routePath, handler) { router.addRoute('HEAD',    routePath, handler); return instance; },
        options(routePath, handler) { router.addRoute('OPTIONS', routePath, handler); return instance; },

        start(): Promise<void> {
            if (isListening) return Promise.reject(new Error('Server is already listening'));
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
