import fs                              from 'fs';
import path                            from 'path';
import zlib                            from 'zlib';
import { IncomingMessage, ServerResponse } from 'http';
import { CachedBuffer, CachedStream }  from '#zorvix/types';
import { isCompressible }              from '#zorvix/mime';
import { parseRange, handleRangeError } from '#zorvix/range';

export function serveBufferFile(
    req:         IncomingMessage,
    res:         ServerResponse,
    fileData:    CachedBuffer,
    baseHeaders: Record<string, string | number>,
    method:      string,
    rangeHeader: string | undefined,
    honorRange:  boolean,
    acceptsGzip: boolean,
    logging:     boolean,
): void {
    const totalSize = fileData.buffer.byteLength;

    if (honorRange) {
        const range = parseRange(rangeHeader!, totalSize);
        if (range === 'not-satisfiable' || range === 'not-implemented') {
            handleRangeError(res, range, totalSize, req.url, logging);
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

export function serveStreamFile(
    req:         IncomingMessage,
    res:         ServerResponse,
    fileData:    CachedStream,
    baseHeaders: Record<string, string | number>,
    method:      string,
    ext:         string,
    rangeHeader: string | undefined,
    honorRange:  boolean,
    acceptsGzip: boolean,
    logging:     boolean,
    root:        string,
): void {
    const totalSize = fileData.size;

    if (honorRange) {
        const range = parseRange(rangeHeader!, totalSize);
        if (range === 'not-satisfiable' || range === 'not-implemented') {
            handleRangeError(res, range, totalSize, req.url, logging);
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
                console.log(`Server: Compressed ${path.relative(root, fileData.path)} in ${ms.toFixed(3)}ms`);
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
