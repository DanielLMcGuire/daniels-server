import path                                from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { serveBufferFile, serveStreamFile } from '#zorvix/serve';
import { isAttachment, cacheControlFor }    from '#zorvix/mime';
import { MAX_HEADERS_COUNT, MAX_URL_LENGTH } from '#zorvix/types';
import type { CachedFile }                  from '#zorvix/types';

type GetFile      = (filepath: string) => Promise<CachedFile | null>;
type DevToolsFn   = (req: IncomingMessage, res: ServerResponse, method: string) => void;

export function resolveFilePath(url: string | undefined, root: string): string | null {
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

export function rejectRequest(
    req:     IncomingMessage,
    res:     ServerResponse,
    logging: boolean,
): boolean {
    if ((req.url?.length ?? 0) > MAX_URL_LENGTH) {
        res.writeHead(414, { 'Content-Type': 'text/plain' });
        res.end('414 URI Too Long');
        if (logging) console.log(`Server: 414 (URL too long: ${req.url?.length} bytes) ${req.url?.slice(0, 80)}…`);
        return true;
    }

    if (Object.keys(req.headers).length > MAX_HEADERS_COUNT) {
        res.writeHead(431, { 'Content-Type': 'text/plain' });
        res.end('431 Request Header Fields Too Large');
        if (logging) console.log(`Server: 431 (${Object.keys(req.headers).length} headers) ${req.url}`);
        return true;
    }

    return false;
}

export function createStaticHandler(
    root:            string,
    getFile:         GetFile,
    handleDevTools:  DevToolsFn | null,
    logging:         boolean,
) {
    return async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const method = req.method ?? 'GET';

        if (handleDevTools &&
            req.url?.split('?')[0].endsWith('/.well-known/appspecific/com.chrome.devtools.json')) {
            handleDevTools(req, res, method);
            return;
        }

        const filepath = resolveFilePath(req.url, root);

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

        if (logging) console.log(`Server: Serving ${path.relative(root, filepath)}`);

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
                rangeHeader, honorRange, acceptsGzip, logging, root);
        }
    };
}
