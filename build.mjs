#!/usr/bin/env node
import esbuild from 'esbuild';
import ts from 'typescript';
import { existsSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
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
    const { entryFiles, outDir, rootDir } = config.ts;

    const compilerOptions = {
        ...tsConfig.options,
        noEmit: false,
        emitDeclarationOnly: true,
        declaration: true,
        outDir,
        rootDir,
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

        program.emit();
    }
}

function cleanupDeclarations() {
    const { outDir, keepDeclarations } = config.ts;

    if (!existsSync(outDir)) return;

    for (const file of readdirSync(outDir)) {
        if (file.endsWith('.d.mts') && !keepDeclarations.has(file)) {
            rmSync(`${outDir}/${file}`);
        }
    }
}

function flattenDeclarations() {
    const { outDir } = config.ts;
    const stack = [outDir];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (
                entry.name.endsWith('.d.mts') ||
                entry.name.endsWith('.d.mts.map') ||
                entry.name.endsWith('.d.ts') ||
                entry.name.endsWith('.d.ts.map')
            ) {
                if (dir !== outDir) renameSync(full, join(outDir, entry.name));
            }
        }
    }
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
        if (entry.isDirectory()) rmSync(join(outDir, entry.name), { recursive: true });
    }
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
        flattenDeclarations();
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
