import { MAX_HEADERS_COUNT, MAX_URL_LENGTH } from '#zorvix/types';
import type { RequestHandler } from '#zorvix/api-types';

/**
 * Returns middleware that logs every incoming request as `Client: METHOD URL`.
 * Register this first so the log line appears before any other processing.
 */
export function createLoggingMiddleware(): RequestHandler {
    return function loggingMiddleware(req, _res, next) {
        console.log(`Client: ${req.method} ${req.url}`);
        return next();
    };
}

/**
 * Returns middleware that short-circuits requests with an oversized URL (414)
 * or an excessive number of headers (431) before they reach the router or
 * static file handler.
 */
export function createGuardMiddleware(logging: boolean): RequestHandler {
    return function guardMiddleware(req, res, next) {
        if ((req.url?.length ?? 0) > MAX_URL_LENGTH) {
            res.writeHead(414, { 'Content-Type': 'text/plain' });
            res.end('414 URI Too Long');
            if (logging) console.log(
                `Server: 414 (URL too long: ${req.url?.length} bytes) ${req.url?.slice(0, 80)}…`,
            );
            return;
        }

        if (Object.keys(req.headers).length > MAX_HEADERS_COUNT) {
            res.writeHead(431, { 'Content-Type': 'text/plain' });
            res.end('431 Request Header Fields Too Large');
            if (logging) console.log(
                `Server: 431 (${Object.keys(req.headers).length} headers) ${req.url}`,
            );
            return;
        }

        return next();
    };
}
