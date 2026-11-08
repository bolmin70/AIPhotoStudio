// Image providers: Google AI Studio (Nano Banana / Gemini image models), OpenAI
// (GPT Image models) and OpenRouter (any model whose output includes images).
// Each provider can list its image models and generate one image per call.
//
// A model describes what it accepts:
//   ratios   the aspect ratios it can make
//   options  extra settings shown as pill rows, e.g.
//            { key: 'size', label: 'Size', values: ['1K','2K','4K'], default: '1K' }
//            Keys used: size, quality, thinking.

/** Every aspect ratio any model offers, in the order the UI shows them. */
export const ALL_RATIOS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];
const BASE_RATIOS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '21:9'];

export class ProviderError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

/** Reads the error body from a failed response and throws a readable error. */
async function fail(res, provider) {
    let detail = '';
    try {
        const text = await res.text();
        try {
            const j = JSON.parse(text);
            detail = j.error?.message || j.error?.metadata?.raw || j.message || text;
        } catch {
            detail = text;
        }
    } catch { /* body unreadable */ }
    const hint = res.status === 401 || res.status === 403 ? ' Check the API key.' : '';
    throw new ProviderError(`${provider} returned ${res.status}: ${String(detail).slice(0, 400)}${hint}`, res.status === 429 ? 429 : 502);
}

const opt = (key, label, values, def) => ({ key, label, values, default: def ?? values[0] });

/** Splits a dated snapshot ("gpt-image-2-2026-04-21") into its base id and date. */
function splitDate(id) {
    const m = /^(.*?)-(\d{4}-\d{2}-\d{2})$/.exec(id);
    return m ? [m[1], m[2]] : [id, null];
}
/** "gpt-image-2.5-sunburst" → "GPT Image 2.5 Sunburst" */
function titleFromId(id) {
    const [base, date] = splitDate(id);
    const name = base.split(/[-_]/).map(w => w === 'gpt' ? 'GPT' : w === 'chatgpt' ? 'ChatGPT' : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return date ? `${name} (${date})` : name;
}

/* ── Google AI Studio ──
   generateContent with responseModalities, imageConfig (aspectRatio, imageSize) and,
   for the models that take one, thinkingConfig.thinkingLevel. */

const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const G_SIZES = opt('size', 'Size', ['1K', '2K', '4K'], '1K');
const GOOGLE_FAMILIES = [
    { test: /nano-banana-2\.1/, name: 'Nano Banana 2.1', note: 'Newest, recommended', ratios: ALL_RATIOS,
        options: [G_SIZES, opt('thinking', 'Thinking', ['minimal', 'medium', 'high'], 'medium')] },
    { test: /3\.1-flash-lite-image/, name: 'Nano Banana 2 Lite', note: 'Fastest and cheapest, 1K only', ratios: BASE_RATIOS,
        options: [opt('thinking', 'Thinking', ['minimal', 'high'], 'minimal')] },
    { test: /3\.1-flash-image/, name: 'Nano Banana 2', note: 'Deprecated, use 2.1', ratios: ALL_RATIOS,
        options: [G_SIZES, opt('thinking', 'Thinking', ['minimal', 'high'], 'minimal')] },
    { test: /3-pro-image/, name: 'Nano Banana Pro', note: 'Premium, always thinks', ratios: BASE_RATIOS, options: [G_SIZES] },
    { test: /2\.5-flash-image/, name: 'Nano Banana', note: 'Original, legacy', ratios: BASE_RATIOS, options: [] }
];
const GOOGLE_FALLBACK = ['gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'];

function googleModel(id, displayName) {
    const fam = GOOGLE_FAMILIES.find(f => f.test.test(id));
    const preview = /preview/.test(id) ? ' (preview)' : '';
    if (!fam) return { id, name: displayName || titleFromId(id), note: 'Gemini image model', ratios: BASE_RATIOS, options: [] };
    return { id, name: fam.name + preview, note: fam.note, ratios: fam.ratios, options: fam.options };
}

const google = {
    name: 'Google AI Studio',
    fallback: () => GOOGLE_FALLBACK.map(id => googleModel(id)),
    async list(key) {
        const out = [];
        let pageToken = '';
        do {
            const url = `${GOOGLE_BASE}/models?pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
            const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
            if (!res.ok) await fail(res, 'Google AI Studio');
            const j = await res.json();
            for (const m of j.models || []) {
                const id = String(m.name || '').replace(/^models\//, '');
                // Gemini image models (Nano Banana) answer generateContent; Imagen used predict and is shut down.
                const isImage = /image|nano-banana/i.test(id) && !/imagen/i.test(id);
                if (isImage && (m.supportedGenerationMethods || []).includes('generateContent')) out.push(googleModel(id, m.displayName));
            }
            pageToken = j.nextPageToken || '';
        } while (pageToken);
        const rank = id => { const i = GOOGLE_FAMILIES.findIndex(f => f.test.test(id)); return i < 0 ? 99 : i; };
        return out.sort((a, b) => rank(a.id) - rank(b.id) || /preview/.test(a.id) - /preview/.test(b.id) || a.id.localeCompare(b.id));
    },
    async generate({ key, model, prompt, ratio, options, refs, signal }) {
        const parts = [];
        if (prompt) parts.push({ text: prompt });
        for (const r of refs) parts.push({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } });
        const generationConfig = { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } };
        if (options.size) generationConfig.imageConfig.imageSize = options.size;
        if (options.thinking) generationConfig.thinkingConfig = { thinkingLevel: options.thinking };
        const res = await fetch(`${GOOGLE_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            signal,
            headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
        });
        if (!res.ok) await fail(res, 'Google AI Studio');
        const j = await res.json();
        const cand = j.candidates?.[0];
        const outParts = cand?.content?.parts || [];
        // Thinking models can send interim "thought" images first; the answer is the last non-thought image.
        const images = outParts.filter(p => (p.inlineData || p.inline_data) && !p.thought);
        const img = images[images.length - 1];
        if (!img) {
            const text = outParts.filter(p => !p.thought).map(p => p.text).filter(Boolean).join(' ').trim();
            const why = j.promptFeedback?.blockReason || cand?.finishReason;
            throw new ProviderError(`Google AI Studio sent no image${why ? ` (${why})` : ''}${text ? `: ${text.slice(0, 300)}` : '.'}`);
        }
        const d = img.inlineData || img.inline_data;
        return { mime: d.mimeType || d.mime_type || 'image/png', data: Buffer.from(d.data, 'base64') };
    }
};

/* ── OpenAI ──
   images/generations, or images/edits with reference images. GPT Image 2 and newer take
   custom WIDTHxHEIGHT sizes (edges divisible by 16, ratio within 1:3–3:1, at most
   3840x2160 worth of pixels); older models take three fixed sizes. 2.5 and 2.6 also take
   `complexity` (how much the model plans before drawing). */

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_FIXED = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' };
const CUSTOM_RATIOS = BASE_RATIOS; // all within 1:3–3:1
const Q_BASIC = ['auto', 'low', 'medium', 'high'];
const CUSTOM_SIZE = opt('size', 'Size', ['1K', '2K', '4K'], '1K');
const COMPLEXITY = opt('thinking', 'Thinking', ['low', 'medium', 'high'], 'high');
const OPENAI_FAMILIES = [
    { test: /^gpt-image-2\.6-sunburst/, note: 'Detailed visual work', custom: true, options: [CUSTOM_SIZE, opt('quality', 'Quality', Q_BASIC, 'auto'), COMPLEXITY] },
    { test: /^gpt-image-2\.6-flare/, note: 'Fast iteration', custom: true, options: [CUSTOM_SIZE, opt('quality', 'Quality', Q_BASIC, 'auto'), COMPLEXITY] },
    { test: /^gpt-image-2\.5-sunburst/, note: 'Most capable', custom: true, options: [CUSTOM_SIZE, opt('quality', 'Quality', [...Q_BASIC, 'xhigh', 'max'], 'auto'), COMPLEXITY] },
    { test: /^gpt-image-2\.5-flare/, note: 'Fast, high quality', custom: true, options: [CUSTOM_SIZE, opt('quality', 'Quality', [...Q_BASIC, 'xhigh', 'max'], 'auto'), COMPLEXITY] },
    { test: /^gpt-image-2(-\d{4}|$)/, note: 'GPT Image 2', custom: true, options: [CUSTOM_SIZE, opt('quality', 'Quality', Q_BASIC, 'auto')] },
    { test: /^gpt-image-1\.5/, note: 'Deprecated', custom: false, options: [opt('quality', 'Quality', Q_BASIC, 'auto')] },
    { test: /^gpt-image-1-mini/, note: 'Deprecated', custom: false, options: [opt('quality', 'Quality', Q_BASIC, 'auto')] },
    { test: /^chatgpt-image/, note: 'Deprecated', custom: false, options: [opt('quality', 'Quality', Q_BASIC, 'auto')] }
];
/** Shut down (gpt-image-1 on 2026-10-23); hidden even if the account still lists them. */
const OPENAI_GONE = /^gpt-image-1(-\d{4}-\d{2}-\d{2})?$/;
const OPENAI_FALLBACK = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'];

function openaiModel(id) {
    const fam = OPENAI_FAMILIES.find(f => f.test.test(id)) || { note: 'GPT Image model', custom: false, options: [opt('quality', 'Quality', Q_BASIC, 'auto')] };
    return { id, name: titleFromId(id), note: fam.note, ratios: fam.custom ? CUSTOM_RATIOS : Object.keys(OPENAI_FIXED), options: fam.options, customSize: fam.custom };
}

/** WIDTHxHEIGHT for a ratio at about 1K/2K/4K on the long edge, within OpenAI's limits. */
export function openaiCustomSize(ratio, size) {
    const [a, b] = ratio.split(':').map(Number);
    const MIN = 655360, MAX = 3840 * 2160;
    const r16 = v => Math.max(16, Math.round(v / 16) * 16);
    // Both edges from the long edge, each a multiple of 16.
    const dims = long => a >= b ? [long, r16(long * b / a)] : [r16(long * a / b), long];
    let long = { '1K': 1024, '2K': 2048, '4K': 3840 }[size] || 1024;
    let [w, h] = dims(long);
    while (w * h > MAX && long > 16) [w, h] = dims(long -= 16);
    while (w * h < MIN && long < 3840) [w, h] = dims(long += 16);
    return `${w}x${h}`;
}

const openai = {
    name: 'OpenAI',
    fallback: () => OPENAI_FALLBACK.map(openaiModel),
    async list(key) {
        const res = await fetch(`${OPENAI_BASE}/models`, { headers: { authorization: `Bearer ${key}` } });
        if (!res.ok) await fail(res, 'OpenAI');
        const j = await res.json();
        const rank = id => { const i = OPENAI_FAMILIES.findIndex(f => f.test.test(id)); return i < 0 ? 99 : i; };
        return (j.data || [])
            .map(m => m.id)
            .filter(id => /^(gpt-image|chatgpt-image)/.test(id) && !OPENAI_GONE.test(id))
            .sort((a, b) => rank(a) - rank(b) || splitDate(a)[0].localeCompare(splitDate(b)[0]) || (splitDate(a)[1] ? 1 : 0) - (splitDate(b)[1] ? 1 : 0) || b.localeCompare(a))
            .map(openaiModel);
    },
    async generate({ key, model, prompt, ratio, options, refs, signal }) {
        const info = openaiModel(model);
        const size = info.customSize ? openaiCustomSize(ratio, options.size || '1K') : (OPENAI_FIXED[ratio] || 'auto');
        const fields = { model, prompt: prompt || 'Create a variation of this image.', size, quality: options.quality || 'auto', n: 1 };
        if (options.thinking) fields.complexity = options.thinking;
        let res;
        if (refs.length) {
            const form = new FormData();
            for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
            refs.forEach((r, i) => form.append('image[]', new Blob([r.data], { type: r.mime }), `reference-${i + 1}.${extFor(r.mime)}`));
            res = await fetch(`${OPENAI_BASE}/images/edits`, { method: 'POST', signal, headers: { authorization: `Bearer ${key}` }, body: form });
        } else {
            res = await fetch(`${OPENAI_BASE}/images/generations`, {
                method: 'POST',
                signal,
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                body: JSON.stringify(fields)
            });
        }
        if (!res.ok) await fail(res, 'OpenAI');
        const j = await res.json();
        const b64 = j.data?.[0]?.b64_json;
        if (!b64) throw new ProviderError('OpenAI sent no image.');
        const fmt = j.output_format || 'png';
        return { mime: `image/${fmt === 'jpg' ? 'jpeg' : fmt}`, data: Buffer.from(b64, 'base64'), size };
    }
};

/* ── OpenRouter ── */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
/** Output modalities of each listed model, so generate() can ask for the right ones. */
const openrouterModalities = new Map();

const openrouter = {
    name: 'OpenRouter',
    fallback: () => [],
    async list(key) {
        const res = await fetch(`${OPENROUTER_BASE}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
        if (!res.ok) await fail(res, 'OpenRouter');
        const j = await res.json();
        return (j.data || [])
            // OpenRouter's own routers (openrouter/auto…) list image output but aren't image models.
            .filter(m => (m.architecture?.output_modalities || []).includes('image') && !String(m.id).startsWith('openrouter/'))
            .map(m => {
                const outMods = m.architecture.output_modalities;
                const inMods = m.architecture.input_modalities || [];
                openrouterModalities.set(m.id, outMods);
                // Models that take reasoning effort get a Thinking row; "auto" leaves it to the model.
                const effort = (m.supported_parameters || []).includes('reasoning_effort');
                return {
                    id: m.id,
                    name: m.name || m.id,
                    note: inMods.includes('image') ? 'Text + image in' : 'Text in only',
                    ratios: BASE_RATIOS,
                    options: effort ? [opt('thinking', 'Thinking', ['auto', 'minimal', 'low', 'medium', 'high'], 'auto')] : [],
                    acceptsImages: inMods.includes('image')
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    },
    async generate({ key, model, prompt, ratio, options, refs, signal }) {
        if (!openrouterModalities.has(model)) {
            try { await openrouter.list(key); } catch { /* fall back to image+text */ }
        }
        const outMods = openrouterModalities.get(model) || ['image', 'text'];
        const content = refs.length
            ? [{ type: 'text', text: prompt || 'Create a variation of this image.' },
                ...refs.map(r => ({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.data.toString('base64')}` } }))]
            : prompt;
        const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
            method: 'POST',
            signal,
            headers: {
                authorization: `Bearer ${key}`,
                'content-type': 'application/json',
                'HTTP-Referer': 'http://localhost',
                'X-Title': 'AI Photo Studio'
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content }],
                modalities: outMods.includes('text') ? ['image', 'text'] : ['image'],
                image_config: { aspect_ratio: ratio },
                ...(options.thinking && options.thinking !== 'auto' ? { reasoning: { effort: options.thinking } } : {})
            })
        });
        if (!res.ok) await fail(res, 'OpenRouter');
        const j = await res.json();
        if (j.error) throw new ProviderError(`OpenRouter: ${j.error.message || 'request failed'}`);
        const msg = j.choices?.[0]?.message || {};
        let url = msg.images?.[msg.images.length - 1]?.image_url?.url;
        if (!url && Array.isArray(msg.content)) url = msg.content.find(p => p.type === 'image_url')?.image_url?.url;
        if (!url) {
            const text = typeof msg.content === 'string' ? msg.content.trim() : '';
            throw new ProviderError(`OpenRouter sent no image${text ? `: ${text.slice(0, 300)}` : '.'}`);
        }
        return await fromUrl(url, signal);
    }
};

/** Turns a data: URL (or, rarely, an https URL) into { mime, data }. */
async function fromUrl(url, signal) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (m) return { mime: m[1] || 'image/png', data: Buffer.from(m[3], m[2] ? 'base64' : 'utf8') };
    const res = await fetch(url, { signal });
    if (!res.ok) throw new ProviderError(`Could not download the image (${res.status}).`);
    return { mime: res.headers.get('content-type') || 'image/png', data: Buffer.from(await res.arrayBuffer()) };
}

export function extFor(mime) {
    return ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' })[mime] || 'png';
}

export const PROVIDERS = { google, openai, openrouter };
