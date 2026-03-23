export interface WorkerOptions {
    port:         number;
    logging:      boolean;
    devTools:     boolean;
    hostRootArg?: string;
    isDev:        boolean;
}

export type CachedBuffer = {
    buffer:       Buffer;
    gzipped:      Buffer | null;
    contentType:  string;
    etag:         string;
    lastModified: string;
    cachedAt:     number;
};

export type CachedStream = {
    path:         string;
    size:         number;
    contentType:  string;
    etag:         string;
    lastModified: string;
    cachedAt:     number;
};

export type CachedFile = CachedBuffer | CachedStream;

export type ByteRange = { start: number; end: number };

export type RangeResult = ByteRange | 'not-satisfiable' | 'not-implemented';

export const MAX_CACHE_SIZE     = 8_112 * 1024; // ~8 MB
export const CACHE_TTL_MS       = 20_000;        // evict entries after 20 s
export const REQUEST_TIMEOUT_MS = 30_000;        // abort stalled requests after 30 s
export const HEADERS_TIMEOUT_MS = 10_000;        // abort connections that never send headers
