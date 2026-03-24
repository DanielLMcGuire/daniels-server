#!/usr/bin/env node
import esbuild from 'esbuild';
import ts from 'typescript';
import { existsSync, readdirSync, rmSync } from 'fs';

/** @type {ts.FormatDiagnosticsHost} */
const diagHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
};

const isWatchMode = process.argv.includes('--watch');

/** @returns {ts.ParsedCommandLine} */
function loadConfig() {
    const configPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json not found');

    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) throw new Error(ts.formatDiagnostic(error, diagHost));

    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, './');
    if (parsed.errors.length) {
        throw new Error(ts.formatDiagnostics(parsed.errors, diagHost));
    }
    return parsed;
}

/** @param {ts.ParsedCommandLine} tsConfig */
function runTypeCheck(tsConfig) {
    const entryFiles = ['src/api.mts', 'src/types.mts'];

    const compilerOptions = {
        ...tsConfig.options,
        noEmit: false,
        emitDeclarationOnly: true,
        declaration: true,
        outDir: 'dist',
        rootDir: 'src',
    };

    if (isWatchMode) {
        console.log('Watching for type changes...');
        const createProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram;

        const host = ts.createWatchCompilerHost(
            entryFiles,
            compilerOptions,
            ts.sys,
            createProgram,
            (diag) => console.error(ts.formatDiagnosticsWithColorAndContext([diag], diagHost)),
            (status) => console.log(ts.formatDiagnostic(status, diagHost))
        );

        ts.createWatchProgram(host);
    } else {
        const program = ts.createProgram(entryFiles, compilerOptions);
        const diagnostics = ts.getPreEmitDiagnostics(program);

        if (diagnostics.length) {
            console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, diagHost));
            process.exit(1);
        }

        program.emit();
    }
}

function cleanupDeclarations() {
    const distPath = 'dist';
    const KEEP = new Set(['api.d.mts']);

    if (!existsSync(distPath)) return;

    for (const file of readdirSync(distPath)) {
        if (file.endsWith('.d.mts') && !KEEP.has(file)) {
            rmSync(`${distPath}/${file}`);
        }
    }
}

async function runBundling() {
    const commonConfig = {
        bundle: true,
        minify: !isWatchMode,
        platform: 'node',
        format: 'esm',
        logLevel: 'info',
    };

    const entryPoints = [
        { in: 'src/cli.mts', out: 'dist/zorvix.min.mjs', banner: { js: '#!/usr/bin/env node' } },
        { in: 'src/api.mts', out: 'dist/api.min.mjs' }
    ];

    for (const entry of entryPoints) {
        const ctx = await esbuild.context({
            ...commonConfig,
            entryPoints: [entry.in],
            outfile: entry.out,
            banner: entry.banner,
        });

        if (isWatchMode) {
            await ctx.watch();
        } else {
            await ctx.rebuild();
            await ctx.dispose();
        }
    }
}

async function build() {
    try {
        const tsConfig = loadConfig();
        runTypeCheck(tsConfig);
        cleanupDeclarations();
        await runBundling();

        if (!isWatchMode) {
            console.log('Build complete.');
        }
    } catch (err) {
        console.error('Build failed:', err.message);
        process.exit(1);
    }
}

build();