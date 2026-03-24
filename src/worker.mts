import http              from 'http';
import https             from 'https';
import fs                from 'fs';
import crypto            from 'crypto';
import path              from 'path';
import { createCache }              from '#zorvix/cache';
import { createDevToolsHandler }    from '#zorvix/devtools';
import { rejectRequest, createStaticHandler } from '#zorvix/static';
import { WorkerOptions, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, MAX_HEADERS_COUNT } from '#zorvix/types';
import { IncomingMessage, ServerResponse } from 'http';

export type { WorkerOptions };

export function runWorker(opts: WorkerOptions): void {
    const { port, logging, devTools, hostRootArg, isDev, tlsKey, tlsCert } = opts;
    const ROOT = hostRootArg ? path.resolve(hostRootArg) : process.cwd();

    const { getFile, startPruning } = createCache(ROOT, logging);
    startPruning();

    const devToolsUUID   = devTools ? crypto.randomUUID() : null;
    const handleDevTools = devToolsUUID
        ? createDevToolsHandler(ROOT, devToolsUUID, logging)
        : null;

    const serveStatic = createStaticHandler(ROOT, getFile, handleDevTools, logging);

    const useTls = !!(tlsKey && tlsCert);
    let tlsContext: { key: Buffer; cert: Buffer } | undefined;
    if (useTls) {
        try {
            tlsContext = {
                key:  fs.readFileSync(tlsKey!),
                cert: fs.readFileSync(tlsCert!),
            };
        } catch (err) {
            console.error('Error: failed to read TLS key/cert files:', err);
            process.exit(1);
        }
    }

    let forcedExit = false;

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let start: bigint | undefined;
        let timerName = '';

        if (logging) {
            console.log(`Client: ${req.method} ${req.url}`);
            start     = process.hrtime.bigint();
            timerName = `Server: ${req.method} ${req.url}`;
        }

        const method = req.method ?? 'GET';

        if (method !== 'GET' && method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' });
            res.end();
            return;
        }

        if (rejectRequest(req, res, logging)) return;

        await serveStatic(req, res);

        res.on('finish', () => {
            if (!logging || !start) return;
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(`${timerName} ${ms.toFixed(3)}ms`);
        });
    }

    const server = useTls
        ? https.createServer(tlsContext!, handleRequest)
        : http.createServer(handleRequest);

    server.headersTimeout  = HEADERS_TIMEOUT_MS;
    server.requestTimeout  = REQUEST_TIMEOUT_MS;
    server.maxHeadersCount = MAX_HEADERS_COUNT;

    server.listen(port, () => {
        const tag      = isDev ? ' [dev]' : '';
        const protocol = useTls ? 'https' : 'http';
        const host     = port !== (useTls ? 443 : 80)
            ? `${protocol}://localhost:${port}/`
            : `${protocol}://localhost/`;
        console.log(`Server running at ${host}${tag}`);
    });

    process.on('SIGINT', () => {
        if (forcedExit) { console.log('Force exiting…'); process.exit(0); }
        console.log('Shutting down gracefully… (Ctrl-C again to force)');
        forcedExit = true;
        server.close(() => { console.log('Server stopped'); process.exit(0); });
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled rejection:', reason);
        process.exit(1);
    });

    process.on('warning', (w) => console.warn('Warning:', w));
}
