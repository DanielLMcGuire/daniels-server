import zlib                                from 'zlib';
import { IncomingMessage, ServerResponse } from 'http';

export function createDevToolsHandler(root: string, uuid: string, logging: boolean) {
    let msgShown = false;

    return function handleDevTools(req: IncomingMessage, res: ServerResponse, method: string): void {
        const payload = zlib.gzipSync(
            JSON.stringify({ workspace: { root, uuid } })
        );
        res.writeHead(200, {
            'Content-Type':     'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length':    payload.byteLength,
        });
        if (method !== 'HEAD') res.end(payload);
        else res.end();

        if (!msgShown) {
            console.log('DevTools: Go to Sources → Workspace and click "Connect"');
            msgShown = true;
        } else if (logging) {
            console.log('DevTools: Workspace re-initialised');
        }
    };
}
