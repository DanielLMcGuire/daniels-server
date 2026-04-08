import { describe, it, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import os      from 'node:os';
import path    from 'node:path';
import http    from 'node:http';
import { gunzip } from 'node:zlib';
import { createServer } from '#zorvix/api';
import { createBodyParser } from '#zorvix/middleware';

function boundPort(srv: ReturnType<typeof createServer>): number {
    return (srv.server.address() as { port: number }).port;
}

type Response = { status: number; headers: http.IncomingHttpHeaders; text: string };
type HeadResponse = { status: number; headers: http.IncomingHttpHeaders };

function request(
    method:  string,
    port:    number,
    urlPath: string,
    reqHeaders: Record<string, string | number> = {},
    body?: string,
): Promise<Response> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: 'localhost', port, path: urlPath, method, headers: reqHeaders },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({
                    status:  res.statusCode ?? 0,
                    headers: res.headers,
                    text:    Buffer.concat(chunks).toString(),
                }));
            },
        );
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

function requestHead(
    port:    number,
    urlPath: string,
    reqHeaders: Record<string, string> = {},
): Promise<HeadResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: 'localhost', port, path: urlPath, method: 'HEAD', headers: reqHeaders },
            (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); },
        );
        req.on('error', reject);
        req.end();
    });
}

const get  = (port: number, p: string, h: Record<string, string | number> = {}) => request('GET',    port, p, h);
const post = (port: number, p: string, body = '', h: Record<string, string | number> = {}) => request('POST', port, p, h, body);
const put  = (port: number, p: string)                                  => request('PUT',    port, p);
const del  = (port: number, p: string)                                  => request('DELETE', port, p);

function makeTmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zorvix-test-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hello</h1>',       'utf8');
    fs.writeFileSync(path.join(dir, 'style.css'),  'body { color: red; }', 'utf8');
    fs.writeFileSync(path.join(dir, 'data.json'),  '{"ok":true}',          'utf8');
    fs.writeFileSync(path.join(dir, 'script.js'),  'console.log("hi");',   'utf8');
    fs.writeFileSync(path.join(dir, 'image.png'),  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return dir;
}

describe('Static file serving', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('serves index.html for GET /', async () => {
        const res = await get(port, '/');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/html/);
        assert.match(res.text, /Hello/);
    });

    it('serves a named CSS file', async () => {
        const res = await get(port, '/style.css');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/css/);
    });

    it('serves JSON with the correct content-type', async () => {
        const res = await get(port, '/data.json');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /application\/json/);
        assert.equal(JSON.parse(res.text).ok, true);
    });

    it('returns 404 for a missing file', async () => {
        const res = await get(port, '/does-not-exist.txt');
        assert.equal(res.status, 404);
    });

    it('includes ETag and Last-Modified headers', async () => {
        const res = await get(port, '/index.html');
        assert.ok(res.headers['etag'],          'ETag header missing');
        assert.ok(res.headers['last-modified'], 'Last-Modified header missing');
    });

    it('advertises Accept-Ranges: bytes', async () => {
        const res = await get(port, '/index.html');
        assert.equal(res.headers['accept-ranges'], 'bytes');
    });

    it('serves images with a binary content-type', async () => {
        const res = await get(port, '/image.png');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /image\/png/);
    });

    it('blocks path traversal attempts', async () => {
        const res = await get(port, '/../etc/passwd');
        assert.ok(res.status === 400 || res.status === 404,
            `Expected 400 or 404, got ${res.status}`);
    });
});

describe('HEAD requests', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('responds 200 with headers but no body', async () => {
        const res = await requestHead(port, '/index.html');
        assert.equal(res.status, 200);
        assert.ok(res.headers['content-type']);
        assert.ok(res.headers['etag']);
    });

    it('responds 404 for a HEAD on a missing file', async () => {
        const res = await requestHead(port, '/nope.html');
        assert.equal(res.status, 404);
    });
});

describe('Conditional requests', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('returns 304 when If-None-Match matches the ETag', async () => {
        const first  = await get(port, '/index.html');
        const etag   = first.headers['etag'] as string;
        const second = await get(port, '/index.html', { 'if-none-match': etag });
        assert.equal(second.status, 304);
    });

    it('returns 200 when If-None-Match does not match', async () => {
        const res = await get(port, '/index.html', { 'if-none-match': '"stale-etag-value"' });
        assert.equal(res.status, 200);
    });

    it('returns 304 when If-Modified-Since matches Last-Modified', async () => {
        const first  = await get(port, '/index.html');
        const lm     = first.headers['last-modified'] as string;
        const second = await get(port, '/index.html', { 'if-modified-since': lm });
        assert.equal(second.status, 304);
    });
});

describe('Range requests', () => {
    let port: number;
    let root: string;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        root = makeTmpRoot();
        fs.writeFileSync(path.join(root, 'ten.txt'), '0123456789', 'utf8');
        srv  = createServer({ port: 0, root });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('returns 206 and the requested byte slice', async () => {
        const res = await request('GET', port, '/ten.txt', { Range: 'bytes=0-4' });
        assert.equal(res.status, 206);
        assert.equal(res.text, '01234');
        assert.match(res.headers['content-range'] ?? '', /bytes 0-4\/10/);
    });

    it('returns 416 when the range is not satisfiable', async () => {
        const res = await request('GET', port, '/ten.txt', { Range: 'bytes=1000-2000' });
        assert.equal(res.status, 416);
    });
});

describe('Gzip compression', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('responds with Content-Encoding: gzip when client sends Accept-Encoding: gzip', async () => {
        const res = await get(port, '/index.html', { 'accept-encoding': 'gzip' });
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-encoding'], 'gzip');
    });

    it('responds without Content-Encoding when client does not accept gzip', async () => {
        const res = await get(port, '/index.html');
        assert.equal(res.headers['content-encoding'], undefined);
    });
});

describe('Safety guardrails', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('returns 414 for a URL that exceeds MAX_URL_LENGTH', async () => {
        const res = await get(port, '/' + 'a'.repeat(2049));
        assert.equal(res.status, 414);
    });

    it('returns 405 for a POST to a path with no registered route', async () => {
        const res = await post(port, '/index.html');
        assert.equal(res.status, 405);
        assert.ok(res.headers['allow'], 'Allow header missing on 405');
    });

    it('returns 405 for a DELETE to an unregistered path', async () => {
        const res = await del(port, '/index.html');
        assert.equal(res.status, 405);
    });
});

describe('REST routing', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv = createServer({ port: 0, root: makeTmpRoot() });

        srv.get('/api/hello', (_req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ method: 'GET' }));
        });

        srv.post('/api/items', (_req, res, _next) => {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ created: true }));
        });

        srv.delete('/api/items', (_req, res, _next) => {
            res.writeHead(204);
            res.end();
        });

        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('invokes a registered GET handler', async () => {
        const res = await get(port, '/api/hello');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).method, 'GET');
    });

    it('invokes a registered POST handler', async () => {
        const res = await post(port, '/api/items', '{}');
        assert.equal(res.status, 201);
        assert.equal(JSON.parse(res.text).created, true);
    });

    it('invokes a registered DELETE handler', async () => {
        const res = await del(port, '/api/items');
        assert.equal(res.status, 204);
    });

    it('falls through to static serving for unmatched GET paths', async () => {
        const res = await get(port, '/index.html');
        assert.equal(res.status, 200);
    });

    it('returns 404 for an unmatched GET path with no static file', async () => {
        const res = await get(port, '/api/nope');
        assert.equal(res.status, 404);
    });
});

describe('Route parameters', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv = createServer({ port: 0, root: makeTmpRoot() });

        srv.get('/users/:id', (req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: req.params['id'] }));
        });

        srv.get('/files/*', (req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ wildcard: req.params['0'] }));
        });

        srv.get('/static/*path', (req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: req.params['path'] }));
        });

        srv.get('/multi/:a/:b', (req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ a: req.params['a'], b: req.params['b'] }));
        });

        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('captures a single named parameter', async () => {
        const res = await get(port, '/users/42');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).id, '42');
    });

    it('captures and decodes a URL-encoded named parameter', async () => {
        const res = await get(port, '/users/hello%20world');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).id, 'hello world');
    });

    it('captures multiple named parameters', async () => {
        const res  = await get(port, '/multi/foo/bar');
        const body = JSON.parse(res.text);
        assert.equal(body.a, 'foo');
        assert.equal(body.b, 'bar');
    });

    it('captures a wildcard segment including slashes', async () => {
        const res = await get(port, '/files/a/b/c.txt');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).wildcard, 'a/b/c.txt');
    });

    it('named wildcard (*path) captures a single segment', async () => {
        const res  = await get(port, '/static/logo.png');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).path, 'logo.png');
    });

    it('named wildcard (*path) captures multiple slash-separated segments', async () => {
        const res  = await get(port, '/static/assets/img/hero.webp');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).path, 'assets/img/hero.webp');
    });

    it('named wildcard param is keyed by name, not by numeric index', async () => {
        const res  = await get(port, '/static/deep/nested/file.js');
        const body = JSON.parse(res.text);
        assert.equal(body.path, 'deep/nested/file.js',
            'param should be keyed as "path", not "0"');
        assert.equal(body['0'], undefined,
            'numeric key "0" must not be present for a named wildcard');
    });

    it('named wildcard (*path) decodes a URL-encoded segment', async () => {
        const res  = await get(port, '/static/my%20file.txt');
        assert.equal(res.status, 200);
        assert.equal(JSON.parse(res.text).path, 'my file.txt');
    });
});

describe('Body Parser Middleware', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv = createServer({ port: 0, root: makeTmpRoot() });
        srv.use(createBodyParser({ limit: 100 }));

        srv.post('/api/echo', (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(req.body));
        });

        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('parses application/json bodies into objects', async () => {
        const payload = JSON.stringify({ key: 'value', num: 42 });
        const res = await post(port, '/api/echo', payload, { 
            'content-type': 'application/json',
            'content-length': payload.length
        });
        
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.text), { key: 'value', num: 42 });
    });

    it('parses text/plain bodies as strings', async () => {
        const payload = 'hello world';

        const res = await post(port, '/api/echo', payload, {
            'content-type': 'text/plain',
            'content-length': payload.length
        });

        assert.equal(res.status, 200);
        assert.strictEqual(JSON.parse(res.text), payload);
    });

    it('returns 413 Content Too Large when body exceeds limit via Content-Length', async () => {
    const oversizedBody = 'a'.repeat(101);
    const res = await post(port, '/api/echo', oversizedBody, { 
        'content-type': 'application/json', 
        'content-length': 101
    });
    
    assert.equal(res.status, 413);
    assert.match(res.text, /Content Too Large/);
});

    it('returns 400 Bad Request for malformed JSON', async () => {
        const malformed = '{"key": "no-closing-brace"';
        const res = await post(port, '/api/echo', malformed, { 
            'content-type': 'application/json',
            'content-length': malformed.length
        });
        
        assert.equal(res.status, 400);
        assert.match(res.text, /Malformed body/);
    });
});

describe('Middleware', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv = createServer({ port: 0, root: makeTmpRoot()});

        srv.use((_req, res, next) => {
            res.setHeader('X-Global', 'yes');
            return next();
        });

        srv.use('/api', (_req, res, next) => {
            res.setHeader('X-Api-Guard', 'active');
            return next();
        });

        srv.get('/api/data', (_req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });

        srv.get('/public/data', (_req, res, _next) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"public":true}');
        });

        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('global middleware runs for every request', async () => {
        const res = await get(port, '/api/data');
        assert.equal(res.headers['x-global'], 'yes');
    });

    it('global middleware also runs for static files', async () => {
        const res = await get(port, '/index.html');
        assert.equal(res.headers['x-global'], 'yes');
    });

    it('path-prefixed middleware runs only for matching paths', async () => {
        const apiRes    = await get(port, '/api/data');
        const publicRes = await get(port, '/public/data');
        assert.equal(apiRes.headers['x-api-guard'],    'active');
        assert.equal(publicRes.headers['x-api-guard'], undefined);
    });

    it('middleware that does not call next() terminates the chain', async () => {
        const srv2 = createServer({ port: 0, root: makeTmpRoot() });
        srv2.use((_req, res, _next) => {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
        });
        srv2.get('/secret', (_req, res, _next) => {
            res.writeHead(200);
            res.end('should never reach here');
        });
        await srv2.start();
        const res = await get(boundPort(srv2), '/secret');
        assert.equal(res.status, 403);
        await srv2.stop();
    });
});

describe('Error propagation', () => {
    it('returns 500 when middleware passes an error to next()', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        srv.use((_req, _res, next) => next(new Error('deliberate error')));
        await srv.start();
        const res = await get(boundPort(srv), '/');
        assert.equal(res.status, 500);
        await srv.stop();
    });

    it('returns 500 when a route handler throws synchronously', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        srv.get('/boom', () => { throw new Error('sync boom'); });
        await srv.start();
        const res = await get(boundPort(srv), '/boom');
        assert.equal(res.status, 500);
        await srv.stop();
    });

    it('returns 500 when a route handler rejects', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        srv.get('/async-boom', async () => { throw new Error('async boom'); });
        await srv.start();
        const res = await get(boundPort(srv), '/async-boom');
        assert.equal(res.status, 500);
        await srv.stop();
    });
});

describe('Server lifecycle', () => {
    it('start() resolves and listening becomes true, stop() resets it', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        assert.equal(srv.listening, false);
        await srv.start();
        assert.equal(srv.listening, true);
        await srv.stop();
        assert.equal(srv.listening, false);
    });

    it('start() rejects when called a second time', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        await srv.start();
        try {
            await assert.rejects(() => srv.start(), /already listening/i);
        } finally {
            await srv.stop();
        }
    });

    it('stop() resolves immediately when not listening', async () => {
        const srv = createServer({ port: 0, root: makeTmpRoot() });
        await srv.stop();
    });

    it('exposes the correct root and port properties', async () => {
        const root = makeTmpRoot();
        const srv  = createServer({ port: 0, root });
        await srv.start();
        assert.equal(srv.root, path.resolve(root));
        assert.equal(typeof srv.port, 'number');
        await srv.stop();
    });
});

describe('DevTools workspace endpoint', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv  = createServer({ port: 0, root: makeTmpRoot(), devTools: true });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('serves the DevTools JSON at the well-known path', async () => {
        const res = await get(port, '/.well-known/appspecific/com.chrome.devtools.json');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /application\/json/);
    });

    it('response includes a workspace root and uuid', async () => {
        const raw = await new Promise<{ body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
            const req = http.request({
                host: 'localhost', port,
                path: '/.well-known/appspecific/com.chrome.devtools.json',
                method: 'GET',
                headers: { 'accept-encoding': 'gzip' },
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => resolve({ body: Buffer.concat(chunks), headers: res.headers }));
            });
            req.on('error', reject);
            req.end();
        });

        const decompressed = await new Promise<Buffer>((resolve, reject) =>
            gunzip(raw.body, (err, out) => err ? reject(err) : resolve(out)),
        );
        const json = JSON.parse(decompressed.toString());
        assert.equal(typeof json.workspace?.root, 'string');
        assert.equal(typeof json.workspace?.uuid, 'string');
    });
});

describe('Extensionless file serving', () => {
    let port: number;
    let root: string;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        root = makeTmpRoot();
        fs.writeFileSync(path.join(root, 'man.html'),   '<h1>man</h1>',   'utf8');
        fs.writeFileSync(path.join(root, 'readme.txt'), '# readme',       'utf8');
        fs.writeFileSync(path.join(root, 'config.json'), '{"x":1}',       'utf8');
        srv  = createServer({ port: 0, root });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('serves an extensionless .html file', async () => {
        const res = await get(port, '/man');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/html/);
        assert.match(res.text, /man/);
    });

    it('serves an extensionless .txt file when no .html exists', async () => {
        const res = await get(port, '/readme');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/plain/);
    });

    it('serves an extensionless .json file when no .html or .txt exists', async () => {
        const res = await get(port, '/config');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /application\/json/);
    });

    it('ignores query-string content when resolving extensionless paths', async () => {
        const res = await get(port, '/man?f=something.1');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'] ?? '', /text\/html/);
    });

    it('returns 404 for an extensionless path with no matching file', async () => {
        const res = await get(port, '/nonexistent');
        assert.equal(res.status, 404);
    });
});

describe('Allow header on 405', () => {
    let port: number;
    let srv:  ReturnType<typeof createServer>;

    before(async () => {
        srv = createServer({ port: 0, root: makeTmpRoot() });
        srv.post('/resource',   (_req, res, _next) => { res.writeHead(201); res.end(); });
        srv.delete('/resource', (_req, res, _next) => { res.writeHead(204); res.end(); });
        await srv.start();
        port = boundPort(srv);
    });

    after(() => srv.stop());

    it('includes registered methods in the Allow header on a 405', async () => {
        const res = await put(port, '/resource');
        assert.equal(res.status, 405);
        assert.match(res.headers['allow'] ?? '', /POST/);
        assert.match(res.headers['allow'] ?? '', /DELETE/);
        assert.match(res.headers['allow'] ?? '', /GET/);
    });
});
