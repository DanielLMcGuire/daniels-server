import cluster from 'cluster';
import { runPrimary } from '#zorvix/primary';
import { runWorker  } from '#zorvix/worker';

const portArg = process.argv[2];
const port: number | undefined = portArg ? parseInt(portArg, 10) : undefined;

const logging  = process.argv.includes('-l')    || process.argv.includes('--log');
const help     = process.argv.includes('-h')    || process.argv.includes('--help');
const isDev    = process.argv.includes('--dev');
const devTools =
    process.argv.includes('-dt')        ||
    process.argv.includes('--devtools') ||
    process.argv.includes('--chrome');

const hostRootArgIdx = process.argv.indexOf('--root') !== -1
    ? process.argv.indexOf('--root')
    : process.argv.indexOf('-r');
const hostRootArg = hostRootArgIdx !== -1 ? process.argv[hostRootArgIdx + 1] : undefined;

const tlsKeyIdx  = process.argv.indexOf('--key');
const tlsCertIdx = process.argv.indexOf('--cert');
const tlsKey     = tlsKeyIdx  !== -1 ? process.argv[tlsKeyIdx  + 1] : undefined;
const tlsCert    = tlsCertIdx !== -1 ? process.argv[tlsCertIdx + 1] : undefined;

function printHelp(ret: number): never {
    console.log('Usage: zorvix [port] [options]');
    console.log('Options:');
    console.log('  -r, --root <dir>  Set the host root directory (default: working dir)');
    console.log('  -l, --log         Enable request logging');
    console.log('  --dev             Dev mode: exit on exception instead of restarting');
    console.log('  -dt, --devtools   Enable Chrome DevTools workspace');
    console.log('  --key  <file>     Path to TLS private key (PEM) — enables HTTPS');
    console.log('  --cert <file>     Path to TLS certificate (PEM) — enables HTTPS');
    console.log('  -h, --help        Show this help message');
    process.exit(ret);
}

if (help) printHelp(0);

if (!port || Number.isNaN(port)) {
    console.error('Error: port must be a number (first argument)');
    printHelp(1);
}

if (hostRootArgIdx !== -1 && !hostRootArg) {
    console.error('Error: --root requires a directory argument');
    printHelp(1);
}

if ((tlsKey && !tlsCert) || (!tlsKey && tlsCert)) {
    console.error('Error: --key and --cert must be used together');
    printHelp(1);
}

if (tlsKeyIdx !== -1 && !tlsKey) {
    console.error('Error: --key requires a file path argument');
    printHelp(1);
}

if (tlsCertIdx !== -1 && !tlsCert) {
    console.error('Error: --cert requires a file path argument');
    printHelp(1);
}

if (cluster.isPrimary && !isDev) {
    runPrimary();
} else {
    runWorker({ port: port!, logging, devTools, hostRootArg, isDev, tlsKey, tlsCert });
}
