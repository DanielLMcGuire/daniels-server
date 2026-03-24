import pkg from '#zorvix/pkg' with { type: 'json' };
/** 
@typedef {{ watch: boolean }} Flags
@typedef {{in: string; out: string; banner?: string;}} Entry
@typedef {{common: BuildOptions; entries: Entry[];}} EsbuildConfig
@typedef {{entryFiles: string[]; outDir: string; rootDir: string; dtsEntry: string; dtsOutput: string;}} TsConfig
@typedef {{flags: Flags; ts: TsConfig; esbuild: EsbuildConfig;}} BuildConfig
*/
/** @type {BuildConfig} */
const config = {
    flags: {
        watch: process.argv.includes('--watch'),
    },

    ts: {
        entryFiles: [pkg.imports['#zorvix/api'], pkg.imports['#zorvix/cli']],
        outDir: 'dist',
        rootDir: 'src',
        dtsEntry:  pkg.imports['#zorvix/types'],
        dtsOutput: pkg.exports['.'].types,
    },

    esbuild: {
        common: {
            bundle: true,
            platform: 'node',
            format: 'esm',
            logLevel: 'info',
        },

        entries: [
            {
                in: pkg.imports['#zorvix/cli'],
                out: pkg.bin['zorvix'],
                banner: '#!/usr/bin/env node',
            },
            {
                in: pkg.imports['#zorvix/api'],
                out: pkg.exports['.'].import,
            },
        ],
    },
};

export default config;