export interface WorkerOptions {
    port:         number;
    logging:      boolean;
    devTools:     boolean;
    hostRootArg?: string;
    isDev:        boolean;
    /** Absolute path to the TLS private-key file (PEM). Requires `tlsCert`. */
    tlsKey?:      string;
    /** Absolute path to the TLS certificate file (PEM). Requires `tlsKey`. */
    tlsCert?:     string;
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

export const MAX_CACHE_SIZE      = 8_112 * 1024;  // ~8 MB
export const CACHE_TTL_MS        = 80_000;        // evict entries after 1.3 m
export const REQUEST_TIMEOUT_MS  = 60_000;        // abort stalled requests after 1 m
export const HEADERS_TIMEOUT_MS  = 10_000;        // abort connections that never send headers
export const MAX_HEADERS_COUNT   = 50;            // reject requests with more headers than this
export const MAX_URL_LENGTH      = 2_048;         // reject URLs longer than this (bytes)
export const SHUTDOWN_GRACE_MS   = 5_000;         // force-close active connections after this
