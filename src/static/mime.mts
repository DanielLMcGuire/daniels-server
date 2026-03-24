import mimeTypes from '#zorvix/mimetypes' with { type: 'json' };

const COMPRESSIBLE_MIME_TYPES = new Set([
    'text/html', 'text/css', 'text/plain', 'text/xml', 'text/csv',
    'text/javascript', 'application/json', 'application/xml',
    'application/xhtml+xml', 'application/rss+xml', 'application/atom+xml',
    'image/svg+xml',
]);

const ATTACHMENT_MIME_TYPES = new Set([
    'application/x-msdownload', 'application/x-msi', 'application/x-apple-diskimage',
    'application/x-newton-compatible-pkg', 'application/vnd.debian.binary-package',
    'application/x-rpm', 'application/vnd.android.package-archive',
    'application/x-ios-app',
    'application/zip-compressed', 'application/x-tar', 'application/gzip', 'application/x-gzip',
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

export function getMimeType(ext: string): string {
    return (mimeTypes as Record<string, string>)[ext.toLowerCase()] ?? 'application/octet-stream';
}

export function isCompressible(ext: string): boolean {
    const mime = (mimeTypes as Record<string, string>)[ext.toLowerCase()];
    return mime !== undefined && COMPRESSIBLE_MIME_TYPES.has(mime);
}

export function isAttachment(ext: string): boolean {
    const mime = (mimeTypes as Record<string, string>)[ext.toLowerCase()];
    return mime !== undefined && ATTACHMENT_MIME_TYPES.has(mime);
}

export function cacheControlFor(ext: string): string {
    const noCache = new Set(['.html', '.htm', '.md', '.markdown', '.txt', '.json']);
    const shortCache = new Set(['.css', '.js', '.svg', '.ico']);
    
    if (noCache.has(ext)) return 'no-cache';
    if (shortCache.has(ext)) return 'public, max-age=3600, must-revalidate';
    
    return 'public, max-age=3600, must-revalidate';
}
