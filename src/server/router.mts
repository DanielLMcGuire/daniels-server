import { IncomingMessage, ServerResponse } from 'http';

/**
 * Optional error value passed to `next()`.  When present the chain is aborted
 * and the error is re-thrown so the top-level try/catch can handle it.
 */
export type NextFunction = (err?: unknown) => void | Promise<void>;

export type RequestHandler = (
    req:  IncomingMessage,
    res:  ServerResponse,
    next: NextFunction,
) => void | Promise<void>;

type MiddlewareEntry = {
    kind:      'middleware';
    mountPath: string | null;
    handler:   RequestHandler;
};

type RouteEntry = {
    kind:       'route';
    method:     string;
    regex:      RegExp;
    paramNames: string[];
    handler:    RequestHandler;
};

type HandlerEntry = MiddlewareEntry | RouteEntry;

/**
 * Compile an Express-style route path into a RegExp + param name list.
 *
 * Supported syntax:
 *   :name   — captures one path segment (no slashes)
 *   *       — captures everything (including slashes)
 */
export function compilePattern(routePath: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];

    let src = routePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    src = src.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_full, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
    });

    let wildcardIdx = 0;
    src = src.replace(/\*/g, () => {
        paramNames.push(String(wildcardIdx++));
        return '(.*)';
    });

    return { regex: new RegExp(`^${src}$`), paramNames };
}

function matchRoute(
    reqUrl:     string | undefined,
    regex:      RegExp,
    paramNames: string[],
): Record<string, string> | null {
    const reqPath = (reqUrl ?? '/').split('?')[0];
    const m = regex.exec(reqPath);
    if (!m) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < paramNames.length; i++) {
        try {
            params[paramNames[i]] = decodeURIComponent(m[i + 1]);
        } catch {
            params[paramNames[i]] = m[i + 1];
        }
    }
    return params;
}

function allowedMethodsFor(reqUrl: string | undefined, entries: HandlerEntry[]): string {
    const methods = new Set<string>(['GET', 'HEAD']);
    for (const entry of entries) {
        if (entry.kind !== 'route') continue;
        if (matchRoute(reqUrl, entry.regex, entry.paramNames) !== null) {
            methods.add(entry.method);
            if (entry.method === 'GET') methods.add('HEAD');
        }
    }
    return [...methods].sort().join(', ');
}

function urlMatchesMount(reqUrl: string | undefined, mountPath: string): boolean {
    const reqPath = (reqUrl ?? '/').split('?')[0];
    return reqPath === mountPath || reqPath.startsWith(mountPath + '/');
}

export function normaliseMountPath(p: string): string {
    const withLeading = p.startsWith('/') ? p : '/' + p;
    return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
}

export function createRouter(logging: boolean) {
    const entries: HandlerEntry[] = [];

    function addMiddleware(mountPath: string | null, handler: RequestHandler): void {
        entries.push({ kind: 'middleware', mountPath, handler });
    }

    function addRoute(method: string, routePath: string, handler: RequestHandler): void {
        const { regex, paramNames } = compilePattern(routePath);
        entries.push({ kind: 'route', method: method.toUpperCase(), regex, paramNames, handler });
    }

    async function dispatch(
        req:         IncomingMessage,
        res:         ServerResponse,
        fallthrough: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
        index = 0,
    ): Promise<void> {
        while (index < entries.length) {
            const entry = entries[index];

            let matches = false;
            if (entry.kind === 'middleware') {
                matches = entry.mountPath === null || urlMatchesMount(req.url, entry.mountPath);
            } else if (entry.method === (req.method ?? 'GET').toUpperCase()) {
                const params = matchRoute(req.url, entry.regex, entry.paramNames);
                if (params !== null) {
                    req.params = params;
                    matches = true;
                }
            }

            if (!matches) { index++; continue; }

            await entry.handler(req, res, (err?: unknown) => {
                if (err !== undefined) return Promise.reject(err);
                if (res.writableEnded) return Promise.resolve();
                return dispatch(req, res, fallthrough, index + 1);
            });
            return;
        }

        if (res.writableEnded) return;

        const method = req.method ?? 'GET';
        if (method === 'GET' || method === 'HEAD') {
            await fallthrough(req, res);
        } else {
            const allow = allowedMethodsFor(req.url, entries);
            res.writeHead(405, { Allow: allow, 'Content-Type': 'text/plain' });
            res.end('405 Method Not Allowed');
            if (logging) console.log(`Server: 405 ${method} ${req.url}`);
        }
    }

    return { addMiddleware, addRoute, dispatch };
}
