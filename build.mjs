#!/usr/bin/env node
import esbuild from 'esbuild';
import ts from 'typescript';
import { generateDtsBundle } from 'dts-bundle-generator';
import { writeFileSync } from 'fs';
import config from './build.config.mjs';

const isWatchMode = config.flags.watch;

/** @type {ts.FormatDiagnosticsHost} */
const diagHost = {
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
};

/** @returns {ts.ParsedCommandLine} */
function loadConfig() {
    const configPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) throw new Error('tsconfig.json not found');

    const { config: raw, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error) throw new Error(ts.formatDiagnostic(error, diagHost));

    const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, './');
    if (parsed.errors.length) {
        throw new Error(ts.formatDiagnostics(parsed.errors, diagHost));
    }

    return parsed;
}

/** @param {ts.ParsedCommandLine} tsConfig */
function runTypeCheck(tsConfig) {
    const { entryFiles } = config.ts;

    const compilerOptions = {
        ...tsConfig.options,
        noEmit: true,
    };

    if (isWatchMode) {
        console.log('Watching for type changes...');

        const host = ts.createWatchCompilerHost(
            entryFiles,
            compilerOptions,
            ts.sys,
            ts.createEmitAndSemanticDiagnosticsBuilderProgram,
            (diag) =>
                console.error(ts.formatDiagnosticsWithColorAndContext([diag], diagHost)),
            (status) => console.log(ts.formatDiagnostic(status, diagHost))
        );

        ts.createWatchProgram(host);
    } else {
        const program = ts.createProgram(entryFiles, compilerOptions);
        const diagnostics = ts.getPreEmitDiagnostics(program);

        if (diagnostics.length) {
            console.error(
                ts.formatDiagnosticsWithColorAndContext(diagnostics, diagHost)
            );
            process.exit(1);
        }
    }
}
function emitDeclarations() {
    const { dtsEntry, dtsOutput } = config.ts;

    const [output] = generateDtsBundle([{
        filePath: dtsEntry,
        libraries: {
            allowedTypesLibraries: ['node'],
        },
        output: { exportReferencedTypes: false },
    }]);

    writeFileSync(dtsOutput, output, 'utf8');
}

async function runBundling() {
    const { common, entries } = config.esbuild;

    for (const entry of entries) {
        const ctx = await esbuild.context({
            ...common,
            entryPoints: [entry.in],
            outfile: entry.out,
            banner: entry.banner ? { js: entry.banner } : undefined,
            minify: !isWatchMode,
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
        emitDeclarations();
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