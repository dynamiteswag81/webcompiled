// Test-only static HTTP server with single-range `Range` support (RFC 9110 subset), used by
// run_web_disc_test.mjs. It is deliberately small; web/serve.py is the operator-facing server.
//
//   const srv = await startServer({ mounts: [{ prefix: '/', dir }], noRangePrefixes, pages });
//   srv.port, srv.log (one {method, path, range, status} per request), srv.close()
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

// Returns {start, end} (inclusive), 'unsatisfiable', or null to send the whole file.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null; // absent, malformed, multi-range
  let start, end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (match[2] !== '' && Number(match[2]) < start) return null;
  }
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

export function startServer({ mounts, noRangePrefixes = [], pages = {} }) {
  const log = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, path: '', range: req.headers.range ?? null, status: 0 };
    log.push(entry);
    const send = (status, headers = {}, body) => {
      entry.status = status;
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(400);
    }
    entry.path = urlPath;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { Allow: 'GET, HEAD' });

    if (pages[urlPath] !== undefined) {
      const page = pages[urlPath];
      return send(200, { 'Content-Type': page.type, 'Content-Length': Buffer.byteLength(page.body) }, page.body);
    }

    const mount = mounts.find((m) => urlPath.startsWith(m.prefix));
    if (!mount) return send(404);
    const root = path.resolve(mount.dir);
    const file = path.resolve(root, '.' + urlPath.slice(mount.prefix.length - 1));
    if (file !== root && !file.startsWith(root + path.sep)) return send(403);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return send(404);
    }
    if (!stat.isFile()) return send(404);

    const size = stat.size;
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const honorRange = !noRangePrefixes.some((prefix) => urlPath.startsWith(prefix));
    const range = honorRange ? parseRange(req.headers.range, size) : null;
    if (range === 'unsatisfiable') {
      return send(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = Math.max(0, end - start + 1);
    const headers = { 'Content-Type': type, 'Content-Length': length };
    if (honorRange) headers['Accept-Ranges'] = 'bytes';
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    entry.status = range ? 206 : 200;
    res.writeHead(entry.status, { 'Cache-Control': 'no-store', ...headers });
    if (req.method === 'HEAD' || length === 0) return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        log,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}
