import cluster                              from 'cluster';
import { compilePattern, normaliseMountPath } from '#zorvix/router';
import type { RequestHandler, ServerInstance } from '#zorvix/api-types';

/**
 * Returns a `ServerInstance` that acts as the cluster **primary** (supervisor).
 *
 * It accepts the same `.use()` / `.get()` / … registration calls as a normal
 * instance so that the entry-point can be written identically for both the
 * primary and the worker.  Registered handlers are silently accepted but never
 * dispatched — the primary never handles HTTP requests directly.
 *
 * `start()` forks one worker and supervises it: if the worker exits
 * unexpectedly it is restarted after a 500 ms delay.  `stop()` sends SIGINT to
 * every live worker and resolves once they have all exited.
 */
export function createPrimaryInstance(port: number, root: string): ServerInstance {
    let isListening  = false;
    let shuttingDown = false;
    let forcedExit   = false;

    function addRoute(_method: string, routePath: string, _handler: RequestHandler): ServerInstance {
        compilePattern(routePath);
        return instance;
    }

    function spawnWorker(): void {
        const worker = cluster.fork();
        worker.on('exit', (code, signal) => {
            if (shuttingDown) return;
            if (signal === 'SIGINT' || signal === 'SIGTERM') return;
            console.error(
                `[primary] Worker ${worker.process.pid} exited` +
                ` (code=${code ?? '—'}, signal=${signal ?? '—'}), restarting in 500 ms…`,
            );
            setTimeout(spawnWorker, 500);
        });
    }

    const instance: ServerInstance = {
        get root()      { return root; },
        get port()      { return port; },
        get listening() { return isListening; },
        get server(): never {
            throw new Error(
                '[zorvix] .server is not available in the cluster primary process — ' +
                'access it from within the worker instead.',
            );
        },

        use(pathOrHandler: string | RequestHandler, maybeHandler?: RequestHandler): ServerInstance {
            if (typeof pathOrHandler !== 'function') {
                if (!maybeHandler) throw new TypeError('use(path, handler): handler is required');
                normaliseMountPath(pathOrHandler);
            }
            return instance;
        },

        get(routePath, handler) { return addRoute('GET',     routePath, handler); },
        post(routePath, handler) { return addRoute('POST',    routePath, handler); },
        put(routePath, handler) { return addRoute('PUT',     routePath, handler); },
        patch(routePath, handler) { return addRoute('PATCH',   routePath, handler); },
        delete(routePath, handler) { return addRoute('DELETE',  routePath, handler); },
        head(routePath, handler) { return addRoute('HEAD',    routePath, handler); },
        options(routePath, handler) { return addRoute('OPTIONS', routePath, handler); },

        start(): Promise<void> {
            if (isListening) return Promise.reject(new Error('Server is already listening'));
            isListening = true;

            spawnWorker();

            process.on('SIGINT', () => {
                if (forcedExit) { process.exit(0); }
                forcedExit   = true;
                shuttingDown = true;
                console.log('[primary] Shutting down (Ctrl-C again to force)…');
                for (const w of Object.values(cluster.workers ?? {})) {
                    w?.process.kill('SIGINT');
                }
            });

            return Promise.resolve();
        },

        stop(): Promise<void> {
            if (!isListening) return Promise.resolve();
            return new Promise((resolve) => {
                shuttingDown = true;
                const workers = Object.values(cluster.workers ?? {}).filter(Boolean);
                if (workers.length === 0) { isListening = false; resolve(); return; }

                let remaining = workers.length;
                for (const w of workers) {
                    w!.once('exit', () => {
                        if (--remaining === 0) { isListening = false; resolve(); }
                    });
                    w!.process.kill('SIGINT');
                }
            });
        },
    };

    return instance;
}
