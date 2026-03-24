export const REQUEST_TIMEOUT_MS  = 60_000;        // abort stalled requests after 1 m
export const HEADERS_TIMEOUT_MS  = 10_000;        // abort connections that never send headers
export const MAX_HEADERS_COUNT   = 50;            // reject requests with more headers than this
export const MAX_URL_LENGTH      = 2_048;         // reject URLs longer than this (bytes)
export const SHUTDOWN_GRACE_MS   = 5_000;         // force-close active connections after this