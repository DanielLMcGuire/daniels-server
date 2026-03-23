import http              from 'http';
import crypto            from 'crypto';
import path              from 'path';
import { createCache }   from '#server/cache';
import { createDevToolsHandler } from '#server/devtools';
import { serveBufferFile, serveStreamFile } from '#server/serve';
import { isAttachment, cacheControlFor }    from '#server/mime';
import { WorkerOptions, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '#server/types';
import { IncomingMessage, ServerResponse }  from 'http';

export type { WorkerOptions };

function getFilePath(url: string | undefined, root: string): string | null {
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

export function runWorker(opts: WorkerOptions): void {
    const { port, logging, devTools, hostRootArg, isDev } = opts;
    const ROOT = hostRootArg ? path.resolve(hostRootArg) : process.cwd();

    const { getFile, startPruning } = createCache(ROOT, logging);
    startPruning();

    const devToolsUUID    = devTools ? crypto.randomUUID() : null;
    const handleDevTools  = devToolsUUID
        ? createDevToolsHandler(ROOT, devToolsUUID, logging)
        : null;

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

        if (handleDevTools && req.url?.split('?')[0].endsWith('/.well-known/appspecific/com.chrome.devtools.json')) {
            handleDevTools(req, res, method);
            return;
        }

        const filepath = getFilePath(req.url, ROOT);

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
            baseHeaders['Content-Disposition'] = `attachment; filename="${filename}"; filename*=UTF-8''${filename}`;
        }

        const rangeHeader = req.headers['range'];
        const ifRange     = req.headers['if-range'];
        const honorRange  = !!rangeHeader && (!ifRange || ifRange === fileData.etag);
        const acceptsGzip = req.headers['accept-encoding']?.includes('gzip') ?? false;

        if ('buffer' in fileData) {
            serveBufferFile(req, res, fileData, baseHeaders, method, rangeHeader, honorRange, acceptsGzip, logging);
        } else {
            serveStreamFile(req, res, fileData, baseHeaders, method, ext, rangeHeader, honorRange, acceptsGzip, logging, ROOT);
        }

        res.on('finish', () => {
            if (!logging || !start) return;
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(`${timerName} ${ms.toFixed(3)}ms`);
        });
    }

    const server = http.createServer(handleRequest);

    server.headersTimeout = HEADERS_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;

    server.listen(port, () => {
        const tag = isDev ? ' [dev]' : '';
        console.log(
            port !== 80
                ? `Server running at http://localhost:${port}/${tag}`
                : `Server running at http://localhost/${tag}`
        );
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
