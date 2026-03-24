import { ServerResponse }          from 'http';
import type { RangeResult, ByteRange }  from '#zorvix/types';

export function parseRange(header: string, totalSize: number): RangeResult {
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

    return { start, end } satisfies ByteRange;
}

export function handleRangeError(
    res:       ServerResponse,
    result:    'not-satisfiable' | 'not-implemented',
    totalSize: number,
    url:       string | undefined,
    logging:   boolean,
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
