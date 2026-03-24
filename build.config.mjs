/** 
@typedef {{ watch: boolean }} Flags
@typedef {{in: string; out: string; banner?: string;}} Entry
@typedef {{common: BuildOptions; entries: Entry[];}} EsbuildConfig
@typedef {{entryFiles: string[]; outDir: string; rootDir: string; keepDeclarations: Set<string>;}} TsConfig
@typedef {{flags: Flags; ts: TsConfig esbuild: EsbuildConfig;}} BuildConfig
*/
/** @type {BuildConfig} */
const config = {
    flags: {
        watch: process.argv.includes('--watch'),
    },

    ts: {
        entryFiles: ['src/api.mts', 'src/types.mts'],
        outDir: 'dist',
        rootDir: 'src',
        keepDeclarations: new Set(['api.d.mts']),
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
                in: 'src/cli.mts',
                out: 'dist/zorvix.min.mjs',
                banner: '#!/usr/bin/env node',
            },
            {
                in: 'src/api.mts',
                out: 'dist/api.min.mjs',
            },
        ],
    },
};

export default config;