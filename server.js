// AI Photo Studio: a local web app for generating images with Google AI Studio,
// OpenAI and OpenRouter. No dependencies: Node's own http server and fetch.
//
//   data/keys.json      API keys (never sent to the browser)
//   data/library.json   collections and image records
//   data/images/        generated images
//   data/refs/          uploaded reference images (deduplicated by content)

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, ProviderError, ALL_RATIOS, extFor } from './src/providers.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const IMAGES = path.join(DATA, 'images');
const REFS = path.join(DATA, 'refs');
const KEYS_FILE = path.join(DATA, 'keys.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const LIBRARY_FILE = path.join(DATA, 'library.json');
const PORT = Number(process.env.PORT) || 8020;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 80 * 1024 * 1024;

for (const dir of [DATA, IMAGES, REFS]) mkdirSync(dir, { recursive: true });

const COLLECTION_COLORS = ['74 222 128', '237 137 54', '96 165 250', '237 100 166', '144 205 244', '245 101 101'];

/* ── Storage ── */

async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
let writeChain = Promise.resolve();
/** Writes JSON atomically, one write at a time. */
function writeJson(file, value) {
    writeChain = writeChain.then(async () => {
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(value, null, 2));
        await fs.rename(tmp, file);
    });
    return writeChain;
}

const keys = Object.assign({ google: '', openai: '', openrouter: '' }, await readJson(KEYS_FILE, {}));
const library = Object.assign({ collections: [], images: [] }, await readJson(LIBRARY_FILE, {}));
const saveLibrary = () => writeJson(LIBRARY_FILE, library);
// enabledModels: { provider: [model ids] } ticked in Providers; null until the first change.
const settings = Object.assign({ enabledModels: null }, await readJson(SETTINGS_FILE, {}));
const keyHint = k => k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '';

const newId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/** Width and height from a PNG, JPEG or WebP header. */
function dimensions(buf) {
    try {
        if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xff) { i++; continue; }
                const marker = buf[i + 1];
                const len = buf.readUInt16BE(i + 2);
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
                i += 2 + len;
            }
        }
        if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
            const kind = buf.toString('ascii', 12, 16);
            if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
            if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
            if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
        }
    } catch { /* unknown format */ }
    return [null, null];
}

/* ── Models (cached for 10 minutes per provider) ── */

const modelCache = new Map();
async function listModels(provider, refresh = false) {
    const p = PROVIDERS[provider];
    const cached = modelCache.get(provider);
    if (!refresh && cached && Date.now() - cached.at < 10 * 60 * 1000 && cached.key === keys[provider]) return cached;
    let entry;
    if (!keys[provider] && provider !== 'openrouter') {
        entry = { models: p.fallback(), source: 'builtin', at: Date.now(), key: keys[provider] };
    } else {
        try {
            const models = await p.list(keys[provider]);
            entry = { models: models.length ? models : p.fallback(), source: models.length ? 'api' : 'builtin', at: Date.now(), key: keys[provider] };
        } catch (err) {
            entry = { models: p.fallback(), source: 'builtin', error: err.message, at: Date.now(), key: keys[provider] };
        }
    }
    modelCache.set(provider, entry);
    return entry;
}

/* ── Reference images ── */

async function resolveRefs(refs = []) {
    const out = [];
    for (const r of refs.slice(0, 16)) {
        if (r.imageId) {
            const img = library.images.find(i => i.id === r.imageId);
            if (!img) throw new ProviderError('A reference image is no longer in the library.', 400);
            out.push({ mime: img.mime, data: await fs.readFile(path.join(IMAGES, img.file)), url: `/images/${img.file}` });
        } else if (r.dataUrl) {
            const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(r.dataUrl);
            if (!m) throw new ProviderError('A reference is not an image.', 400);
            const data = Buffer.from(m[2], 'base64');
            const file = `${crypto.createHash('sha1').update(data).digest('hex').slice(0, 20)}.${extFor(m[1])}`;
            const full = path.join(REFS, file);
            if (!existsSync(full)) await fs.writeFile(full, data);
            out.push({ mime: m[1], data, url: `/refs/${file}` });
        }
    }
    return out;
}

/* ── HTTP helpers ── */

function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(data);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > MAX_BODY) { reject(new ProviderError('Request too large (80 MB limit).', 413)); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ProviderError('Invalid JSON.', 400)); }
        });
        req.on('error', reject);
    });
}
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon'
};
async function serveFile(res, base, rel, extraHeaders = {}) {
    const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    if (!full.startsWith(base)) return send(res, 403, { error: 'Forbidden' });
    try {
        const st = await fs.stat(full);
        if (!st.isFile()) throw new Error();
        res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, ...extraHeaders });
        createReadStream(full).pipe(res);
    } catch {
        send(res, 404, { error: 'Not found' });
    }
}
const publicState = () => ({
    collections: library.collections,
    images: library.images,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, hasKey: !!keys[id], keyHint: keyHint(keys[id]) }])),
    ratios: ALL_RATIOS,
    settings
});

/* ── Routes ── */

async function api(req, res, url) {
    const { pathname } = url;
    const m = req.method;

    if (m === 'GET' && pathname === '/api/state') return send(res, 200, publicState());

    if (m === 'POST' && pathname === '/api/keys') {
        const { provider, key } = await readBody(req);
        if (!PROVIDERS[provider]) return send(res, 400, { error: 'Unknown provider.' });
        keys[provider] = String(key || '').trim();
        await writeJson(KEYS_FILE, keys);
        modelCache.delete(provider);
        return send(res, 200, { provider, hasKey: !!keys[provider], keyHint: keyHint(keys[provider]) });
    }

    if (m === 'POST' && pathname === '/api/settings') {
        const body = await readBody(req);
        if (body.enabledModels !== undefined) {
            const clean = {};
            for (const pid of Object.keys(PROVIDERS)) {
                const ids = body.enabledModels?.[pid];
                if (Array.isArray(ids)) clean[pid] = [...new Set(ids.filter(id => typeof id === 'string' && id.length < 200))];
            }
            settings.enabledModels = clean;
        }
        await writeJson(SETTINGS_FILE, settings);
        return send(res, 200, settings);
    }

    let mm;
    if (m === 'GET' && (mm = /^\/api\/models\/(\w+)$/.exec(pathname))) {
        if (!PROVIDERS[mm[1]]) return send(res, 404, { error: 'Unknown provider.' });
        const entry = await listModels(mm[1], url.searchParams.has('refresh'));
        return send(res, 200, { models: entry.models, source: entry.source, error: entry.error || null, fetchedAt: entry.at });
    }

    if (m === 'POST' && pathname === '/api/generate') {
        const body = await readBody(req);
        const { provider, model, prompt = '', ratio = '1:1', collection = null } = body;
        // Model settings (size, quality, thinking), as plain strings.
        const options = {};
        for (const k of ['size', 'quality', 'thinking']) {
            const v = body.options?.[k];
            if (typeof v === 'string' && /^[\w.-]{1,16}$/.test(v)) options[k] = v;
        }
        const p = PROVIDERS[provider];
        if (!p) return send(res, 400, { error: 'Unknown provider.' });
        if (!keys[provider]) return send(res, 400, { error: `Add your ${p.name} key first.` });
        if (!model) return send(res, 400, { error: 'Pick a model first.' });
        if (!String(prompt).trim() && !(body.refs || []).length) return send(res, 400, { error: 'Write a prompt or add a reference image.' });

        const refs = await resolveRefs(body.refs);
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const started = Date.now();
        if (!ALL_RATIOS.includes(ratio)) return send(res, 400, { error: `Unsupported aspect ratio ${ratio}.` });
        const out = await p.generate({ key: keys[provider], model, prompt: String(prompt).trim(), ratio, options, refs, signal: abort.signal });
        if (abort.signal.aborted) return;

        const id = newId();
        const file = `${id}.${extFor(out.mime)}`;
        await fs.writeFile(path.join(IMAGES, file), out.data);
        const [width, height] = dimensions(out.data);
        const record = {
            id, file, mime: out.mime, width, height,
            prompt: String(prompt).trim(), provider, model, ratio, options,
            collection: library.collections.some(c => c.id === collection) ? collection : null,
            refs: refs.map(r => r.url),
            created: Date.now(), seconds: Math.round((Date.now() - started) / 100) / 10
        };
        library.images.unshift(record);
        await saveLibrary();
        return send(res, 200, record);
    }

    if (m === 'PATCH' && pathname === '/api/images') {
        const { ids = [], collection = null } = await readBody(req);
        const target = collection && library.collections.some(c => c.id === collection) ? collection : null;
        for (const img of library.images) if (ids.includes(img.id)) img.collection = target;
        await saveLibrary();
        return send(res, 200, { ok: true });
    }

    if (m === 'DELETE' && pathname === '/api/images') {
        const { ids = [] } = await readBody(req);
        const gone = library.images.filter(i => ids.includes(i.id));
        library.images = library.images.filter(i => !ids.includes(i.id));
        await saveLibrary();
        for (const img of gone) await fs.rm(path.join(IMAGES, img.file), { force: true });
        return send(res, 200, { ok: true, deleted: gone.length });
    }

    if (m === 'GET' && (mm = /^\/api\/images\/(\w+)\/download$/.exec(pathname))) {
        const img = library.images.find(i => i.id === mm[1]);
        if (!img) return send(res, 404, { error: 'Not found' });
        const slug = img.prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
        return serveFile(res, IMAGES, img.file, { 'content-disposition': `attachment; filename="${slug}-${img.id}${path.extname(img.file)}"` });
    }

    if (m === 'POST' && pathname === '/api/collections') {
        const { name } = await readBody(req);
        const clean = String(name || '').trim().slice(0, 60);
        if (!clean) return send(res, 400, { error: 'Name the collection.' });
        const c = { id: 'c' + newId(), name: clean, rgb: COLLECTION_COLORS[library.collections.length % COLLECTION_COLORS.length] };
        library.collections.push(c);
        await saveLibrary();
        return send(res, 200, c);
    }

    if ((mm = /^\/api\/collections\/(\w+)$/.exec(pathname))) {
        const c = library.collections.find(x => x.id === mm[1]);
        if (!c) return send(res, 404, { error: 'No such collection.' });
        if (m === 'PATCH') {
            const { name } = await readBody(req);
            const clean = String(name || '').trim().slice(0, 60);
            if (clean) c.name = clean;
            await saveLibrary();
            return send(res, 200, c);
        }
        if (m === 'DELETE') {
            library.collections = library.collections.filter(x => x !== c);
            for (const img of library.images) if (img.collection === c.id) img.collection = null;
            await saveLibrary();
            return send(res, 200, { ok: true });
        }
    }

    return send(res, 404, { error: 'Unknown endpoint.' });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) return await api(req, res, url);
        if (url.pathname.startsWith('/images/')) return await serveFile(res, IMAGES, url.pathname.slice(8), { 'cache-control': 'public, max-age=31536000, immutable' });
        if (url.pathname.startsWith('/refs/')) return await serveFile(res, REFS, url.pathname.slice(6), { 'cache-control': 'public, max-age=31536000, immutable' });
        return await serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    } catch (err) {
        if (res.headersSent || res.destroyed) return;
        if (err.name === 'AbortError') return;
        const status = err instanceof ProviderError ? err.status : 500;
        if (status === 500) console.error(err);
        send(res, status, { error: err.message || 'Something went wrong.' });
    }
});
server.listen(PORT, HOST, () => console.log(`AI Photo Studio is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
