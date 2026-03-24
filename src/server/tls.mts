import fs from 'fs';

/**
 * Resolve a PEM value that is either a file-system path (string) or
 * already-loaded key/certificate material (Buffer).
 */
export function resolvePem(value: string | Buffer): Buffer {
    return Buffer.isBuffer(value) ? value : fs.readFileSync(value);
}
