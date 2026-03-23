import cluster from 'cluster';

export function runPrimary(): void {
    let shuttingDown = false;

    function spawnWorker(): void {
        const worker = cluster.fork();
        worker.on('exit', (code, signal) => {
            if (shuttingDown) return;
            if (signal === 'SIGINT' || signal === 'SIGTERM') return;
            console.error(
                `[primary] Worker ${worker.process.pid} exited` +
                ` (code=${code ?? '—'}, signal=${signal ?? '—'}), restarting in 500 ms…`
            );
            setTimeout(spawnWorker, 500);
        });
    }

    spawnWorker();

    let forcedExit = false;
    process.on('SIGINT', () => {
        if (forcedExit) { process.exit(0); }
        forcedExit   = true;
        shuttingDown = true;
        console.log('[primary] Shutting down (Ctrl-C again to force)…');
        for (const w of Object.values(cluster.workers ?? {})) {
            w?.process.kill('SIGINT');
        }
    });
}
