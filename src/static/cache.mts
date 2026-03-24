import fs      from 'fs';
import crypto  from 'crypto';
import path    from 'path';
import zlib    from 'zlib';
import { getMimeType, isCompressible }  from '#zorvix/mime';
import { MAX_CACHE_SIZE, CACHE_TTL_MS } from '#zorvix/types';
import type { CachedFile, CachedBuffer }  from '#zorvix/types';

function gzipAsync(buf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) =>
        zlib.gzip(buf, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (err, out) =>
            err ? reject(err) : resolve(out)
        )
    );
}

export function createCache(root: string, logging: boolean) {
    const fileCache    = new Map<string, CachedFile>();
    let cacheUsedBytes = 0;

    function logCacheUsage(action: string, filepath: string): void {
        const pct = ((cacheUsedBytes / MAX_CACHE_SIZE) * 100).toFixed(1);
        console.log(`Server: ${action} ${path.relative(root, filepath)}`);
        console.log(
            `Server: Cache ${(cacheUsedBytes / 1_000).toFixed(1)} KB` +
            `/${(MAX_CACHE_SIZE / 1_000).toFixed(1)} KB (${pct}%)`
        );
    }

    function startPruning(): void {
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of fileCache) {
                if (now - entry.cachedAt >= CACHE_TTL_MS) {
                    if ('buffer' in entry) cacheUsedBytes -= entry.buffer.length;
                    fileCache.delete(key);
                    if (logging) console.log(`Server: Cache pruned ${path.relative(root, key)}`);
                }
            }
        }, CACHE_TTL_MS).unref();
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
            if (logging) console.log(`Server: Cache expired ${path.relative(root, filepath)}`);
        }

        try {
            const stats = await fs.promises.stat(filepath);
            if (!stats.isFile()) return null;

            const ext          = path.extname(filepath);
            const contentType  = getMimeType(ext);
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

    return { getFile, startPruning };
}
