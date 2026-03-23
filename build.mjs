import esbuild from 'esbuild';
import ts from 'typescript';

console.log('type checking');

const configPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');

const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw new Error(ts.formatDiagnostic(error, ts.createCompilerHost({})));

const { options, fileNames, errors } = ts.parseJsonConfigFileContent(config, ts.sys, './');
if (errors.length) throw new Error(ts.formatDiagnostics(errors, ts.createCompilerHost({})));

options.noEmit = true;

const program     = ts.createProgram(fileNames, options);
const diagnostics = ts.getPreEmitDiagnostics(program);

if (diagnostics.length) {
    const host = {
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getCanonicalFileName: (f) => f,
        getNewLine:           () => '\n',
    };
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
    process.exit(1);
}

console.log('compiling and bundling');

await esbuild.build({
    entryPoints: ['src/server.mts'],
    bundle:      true,
    minify:      true,
    platform:    'node',
    format:      'esm',
    outfile:     'dist/server.min.mjs',
    banner:      { js: '#!/usr/bin/env node' },
});

console.log('done');
