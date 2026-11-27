import {createServer} from 'node:http';
import {mkdir, readFile, writeFile, rename, stat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {starter, validate} from './public/model.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = resolve(process.env.AWS_FIELD_DATA || resolve(root, 'data'));
const file = resolve(dataDir, 'workspace.json');
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT || 4187);
await mkdir(dataDir, {recursive: true});
let state;
try {
  state = JSON.parse(await readFile(file, 'utf8'));
  for (const doc of state.documents) validate(doc.graph);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = {revision: 0, documents: [{id: crypto.randomUUID(), graph: starter()}]};
}
let queue = Promise.resolve();
const mime = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};

function reply(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-AWS-Field-Simulation': '1', 'X-AWS-Field-Practice': '1', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Diagram request exceeds 2 MB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

export async function handleRequest(req, res) {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/workspace') {
    if (req.method === 'GET') return reply(res, 200, state);
    if (req.method !== 'PUT') return reply(res, 405, {error: 'Method unavailable.'});
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['content-type'] !== 'application/json') return reply(res, 403, {error: 'Open the app directly to edit diagrams.'});
    let input;
    try { input = await readBody(req); } catch (error) { return reply(res, 400, {error: error.message}); }
    const update = queue.then(async () => {
      if (input?.revision !== state.revision) return reply(res, 409, {error: 'Another device saved changes. The latest workspace has been loaded. Repeat your edit to apply it.', state});
      try {
        if (!Array.isArray(input.documents) || !input.documents.length || input.documents.length > 50) throw new Error('Keep between 1 and 50 diagrams in the workspace.');
        const ids = new Set();
        for (const doc of input.documents) {
          if (typeof doc?.id !== 'string' || !doc.id || doc.id.length > 100 || ids.has(doc.id)) throw new Error('Each diagram needs a distinct ID.');
          ids.add(doc.id);
          validate(doc.graph);
        }
      } catch (error) { return reply(res, 400, {error: error.message}); }
      const next = {revision: state.revision + 1, documents: input.documents};
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), {mode: 0o600});
      await rename(temporary, file);
      state = next;
      reply(res, 200, state);
    });
    queue = update.catch(error => {
      console.error(error);
      if (!res.headersSent) reply(res, 500, {error: 'The server could not save this edit.'});
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, {error: 'Method unavailable.'});
  let source;
  if (path === '/vendor/three.module.js' || path === '/vendor/three.core.js') {
    source = resolve(root, 'node_modules/three/build', path.split('/').at(-1));
  } else {
    source = resolve(publicDir, `.${path === '/' ? '/index.html' : path}`);
    if (!source.startsWith(publicDir + sep)) return reply(res, 404, {error: 'Not found.'});
  }
  const type = mime[extname(source)];
  if (!type) return reply(res, 404, {error: 'Not found.'});
  try {
    if (req.method === 'HEAD') await stat(source);
    reply(res, 200, req.method === 'HEAD' ? '' : await readFile(source), type);
  } catch { reply(res, 404, {error: 'Not found.'}); }
}

if (resolve(process.argv[1] || '.') === fileURLToPath(import.meta.url)) {
  createServer(handleRequest).listen(port, '127.0.0.1', () => console.log(`AWS Field at http://127.0.0.1:${port}`));
}
