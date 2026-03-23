import http, { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import zlib from 'zlib';
import mimeTypes from '#server/mimetypes' with { type: 'json' };

export interface WorkerOptions {
    port:         number;
    logging:      boolean;
    devTools:     boolean;
    hostRootArg?: string;
    isDev:        boolean;
}

type CachedBuffer = {
    buffer:       Buffer;
    gzipped:      Buffer | null;
    contentType:  string;
    etag:         string;
    lastModified: string;
    cachedAt:     number;
};

type CachedStream = {
    path:         string;
    size:         number;
    contentType:  string;
    etag:         string;
    lastModified: string;
    cachedAt:     number;
};

type CachedFile = CachedBuffer | CachedStream;

type ByteRange = { start: number; end: number };

type RangeResult = ByteRange | 'not-satisfiable' | 'not-implemented';

const MAX_CACHE_SIZE     = 8_112 * 1024; // ~8 MB
const CACHE_TTL_MS       = 20_000;       // evict entries after 20 s
const REQUEST_TIMEOUT_MS = 30_000;       // abort stalled requests after 30 s
const HEADERS_TIMEOUT_MS = 10_000;       // abort connections that never send headers

const COMPRESSIBLE_MIME_TYPES = new Set([
    'text/html', 'text/css', 'text/plain', 'text/xml', 'text/csv',
    'application/javascript', 'application/json', 'application/xml',
    'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml',
    'image/svg+xml',
]);

const ATTACHMENT_MIME_TYPES = new Set([
    'application/x-msdownload', 'application/x-msi', 'application/x-apple-diskimage',
    'application/x-newton-compatible-pkg', 'application/vnd.debian.binary-package',
    'application/x-rpm', 'application/vnd.android.package-archive',
    'application/x-ios-app',
    'application/zip', 'application/x-tar', 'application/gzip', 'application/x-gzip',
    'application/x-bzip2', 'application/x-xz', 'application/x-7z-compressed',
    'application/vnd.rar', 'application/x-rar-compressed', 'application/zstd',
    'application/x-iso9660-image', 'application/x-raw-disk-image', 'application/octet-stream',
    'application/java-archive',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
]);

function isCompressible(ext: string): boolean {
    const mime = (mimeTypes as Record<string, string>)[ext.toLowerCase()];
    return mime !== undefined && COMPRESSIBLE_MIME_TYPES.has(mime);
}

function isAttachment(ext: string): boolean {
    const mime = (mimeTypes as Record<string, string>)[ext.toLowerCase()];
    return mime !== undefined && ATTACHMENT_MIME_TYPES.has(mime);
}

function gzipAsync(buf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        zlib.gzip(buf, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (err, out) =>
            err ? reject(err) : resolve(out)
        )
    );
}

function cacheControlFor(ext: string): string {
    return ext === '.html' ? 'no-cache' : 'public, max-age=3600, must-revalidate';
}

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

function parseRange(header: string, totalSize: number): RangeResult {
    if (header.includes(',')) return 'not-implemented';

    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return 'not-satisfiable';

    const hasStart = m[1] !== '';
    const hasEnd   = m[2] !== '';

    if (!hasStart && !hasEnd) return 'not-satisfiable';

    let start: number;
    let end:   number;

    if (!hasStart) {
        const suffix = parseInt(m[2], 10);
        start = Math.max(0, totalSize - suffix);
        end   = totalSize - 1;
    } else {
        start = parseInt(m[1], 10);
        end   = hasEnd ? parseInt(m[2], 10) : totalSize - 1;
    }

    end = Math.min(end, totalSize - 1);
    if (start > end || start >= totalSize) return 'not-satisfiable';

    return { start, end };
}

export function runWorker(opts: WorkerOptions): void {
    const { port, logging, devTools, hostRootArg, isDev } = opts;
    const ROOT = hostRootArg ? path.resolve(hostRootArg) : process.cwd();
    const fileCache = new Map<string, CachedFile>();
    let cacheUsedBytes = 0;

    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of fileCache) {
            if (now - entry.cachedAt >= CACHE_TTL_MS) {
                if ('buffer' in entry) cacheUsedBytes -= entry.buffer.length;
                fileCache.delete(key);
                if (logging) console.log(`Server: Cache pruned ${path.relative(ROOT, key)}`);
            }
        }
    }, CACHE_TTL_MS).unref();

    const devToolsUUID = devTools ? crypto.randomUUID() : null;
    let devToolsMsgShown = false;

    let forcedExit = false;

    function logCacheUsage(action: string, filepath: string): void {
        const pct = ((cacheUsedBytes / MAX_CACHE_SIZE) * 100).toFixed(1);
        console.log(`Server: ${action} ${path.relative(ROOT, filepath)}`);
        console.log(
            `Server: Cache ${(cacheUsedBytes / 1_000).toFixed(1)} KB` +
            `/${(MAX_CACHE_SIZE / 1_000).toFixed(1)} KB (${pct}%)`
        );
    }

    async function getFile(filepath: string): Promise<CachedFile | null> {
        const cached = fileCache.get(filepath);

        if (cached) {
            if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
                if (logging) logCacheUsage('Cache hit', filepath);
                return cached;
            }
            if ('buffer' in cached) cacheUsedBytes -= cached.buffer.length;
            fileCache.delete(filepath);
            if (logging) console.log(`Server: Cache expired ${path.relative(ROOT, filepath)}`);
        }

        try {
            const stats = await fs.promises.stat(filepath);
            if (!stats.isFile()) return null;

            const ext          = path.extname(filepath);
            const contentType  = (mimeTypes as Record<string, string>)[ext] ?? 'application/octet-stream';
            const lastModified = stats.mtime.toUTCString();

            if (stats.size <= MAX_CACHE_SIZE) {
                const buffer  = await fs.promises.readFile(filepath);
                const etag    = `"${crypto.createHash('sha1').update(buffer).digest('hex')}"`;
                const gzipped = isCompressible(ext) ? await gzipAsync(buffer) : null;

                const data: CachedBuffer = { buffer, gzipped, contentType, etag, lastModified, cachedAt: Date.now() };
                fileCache.set(filepath, data);
                cacheUsedBytes += buffer.length;
                if (logging) logCacheUsage('Added', filepath);
                return data;
            }

            const etag = `"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
            return { path: filepath, size: stats.size, contentType, etag, lastModified, cachedAt: Date.now() };

        } catch {
            return null;
        }
    }

    function handleDevTools(req: IncomingMessage, res: ServerResponse, method: string): void {
        const payload = zlib.gzipSync(
            JSON.stringify({ workspace: { root: ROOT, uuid: devToolsUUID } })
        );
        res.writeHead(200, {
            'Content-Type':     'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length':    payload.byteLength,
        });
        if (method !== 'HEAD') res.end(payload);
        else res.end();

        if (!devToolsMsgShown) {
            console.log('DevTools: Go to Sources → Workspace and click "Connect"');
            devToolsMsgShown = true;
        } else if (logging) {
            console.log('DevTools: Workspace re-initialised');
        }
    }

    function handleRangeError(
        res: ServerResponse,
        result: 'not-satisfiable' | 'not-implemented',
        totalSize: number,
        url: string | undefined,
    ): void {
        if (result === 'not-implemented') {
            res.writeHead(501, { 'Content-Type': 'text/plain' });
            res.end('501 Not Implemented: multi-range requests are not supported');
            if (logging) console.log(`Server: 501 (multi-range) ${url}`);
        } else {
            res.writeHead(416, { 'Content-Range': `bytes */${totalSize}`, 'Content-Type': 'text/plain' });
            res.end('416 Range Not Satisfiable');
            if (logging) console.log(`Server: 416 ${url}`);
        }
    }

    function serveBufferFile(
        req:         IncomingMessage,
        res:         ServerResponse,
        fileData:    CachedBuffer,
        baseHeaders: Record<string, string | number>,
        method:      string,
        rangeHeader: string | undefined,
        honorRange:  boolean,
        acceptsGzip: boolean,
    ): void {
        const totalSize = fileData.buffer.byteLength;

        if (honorRange) {
            const range = parseRange(rangeHeader!, totalSize);
            if (range === 'not-satisfiable' || range === 'not-implemented') {
                handleRangeError(res, range, totalSize, req.url);
                return;
            }
            const { start, end } = range;
            const body = fileData.buffer.subarray(start, end + 1);
            res.writeHead(206, {
                ...baseHeaders,
                'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': body.byteLength,
            });
            if (method !== 'HEAD') res.end(body);
            else res.end();
        } else if (acceptsGzip && fileData.gzipped) {
            const body = fileData.gzipped;
            res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': body.byteLength });
            if (method !== 'HEAD') res.end(body);
            else res.end();
        } else {
            const body = fileData.buffer;
            res.writeHead(200, { ...baseHeaders, 'Content-Length': body.byteLength });
            if (method !== 'HEAD') res.end(body);
            else res.end();
        }
    }

    function serveStreamFile(
        req:         IncomingMessage,
        res:         ServerResponse,
        fileData:    CachedStream,
        baseHeaders: Record<string, string | number>,
        method:      string,
        ext:         string,
        rangeHeader: string | undefined,
        honorRange:  boolean,
        acceptsGzip: boolean,
    ): void {
        const totalSize = fileData.size;

        if (honorRange) {
            const range = parseRange(rangeHeader!, totalSize);
            if (range === 'not-satisfiable' || range === 'not-implemented') {
                handleRangeError(res, range, totalSize, req.url);
                return;
            }
            const { start, end } = range;
            res.writeHead(206, {
                ...baseHeaders,
                'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
                'Content-Length': end - start + 1,
            });
            if (method === 'HEAD') { res.end(); return; }
            const fileStream = fs.createReadStream(fileData.path, { start, end });
            fileStream.on('error', () => {
                if (!res.headersSent) res.statusCode = 500;
                res.end('Internal Server Error');
            });
            fileStream.pipe(res);
        } else if (method === 'HEAD') {
            res.writeHead(200, baseHeaders);
            res.end();
        } else if (acceptsGzip && isCompressible(ext)) {
            const compressStart = logging ? process.hrtime.bigint() : undefined;
            res.writeHead(200, { ...baseHeaders, 'Content-Encoding': 'gzip' });

            const gzip       = zlib.createGzip();
            const fileStream = fs.createReadStream(fileData.path);

            const onError = () => {
                if (!res.headersSent) res.statusCode = 500;
                res.end('Internal Server Error');
            };
            gzip.on('error', onError);
            fileStream.on('error', onError);
            gzip.on('finish', () => {
                if (logging && compressStart) {
                    const ms = Number(process.hrtime.bigint() - compressStart) / 1e6;
                    console.log(`Server: Compressed ${path.relative(ROOT, fileData.path)} in ${ms.toFixed(3)}ms`);
                }
            });

            fileStream.pipe(gzip).pipe(res);
        } else {
            res.writeHead(200, baseHeaders);
            const fileStream = fs.createReadStream(fileData.path);
            fileStream.on('error', () => {
                if (!res.headersSent) res.statusCode = 500;
                res.end('Internal Server Error');
            });
            fileStream.pipe(res);
        }
    }

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

        if (devTools && req.url?.split('?')[0].endsWith('/.well-known/appspecific/com.chrome.devtools.json')) {
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
            serveBufferFile(req, res, fileData, baseHeaders, method, rangeHeader, honorRange, acceptsGzip);
        } else {
            serveStreamFile(req, res, fileData, baseHeaders, method, ext, rangeHeader, honorRange, acceptsGzip);
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
