// AI Photo Studio client: the gallery, the Generate dock, the image viewer and the
// Providers dialog. Everything persistent goes through the local server (server.js).

const $ = s => document.querySelector(s);
const fa = (n, extra = '') => `<i class="fa-solid fa-${n}${extra ? ' ' + extra : ''}" aria-hidden="true"></i>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uidN = 0;
const uid = () => 't' + (++uidN) + Math.random().toString(36).slice(2, 6);

const PROV_RGB = { google: '246 173 85', openai: '104 211 145', openrouter: '183 148 244' };
const PROV_ORDER = ['google', 'openai', 'openrouter'];
const KEY_HELP = {
    google: ['https://aistudio.google.com/apikey', 'aistudio.google.com/apikey'],
    openai: ['https://platform.openai.com/api-keys', 'platform.openai.com/api-keys'],
    openrouter: ['https://openrouter.ai/settings/keys', 'openrouter.ai/settings/keys']
};
const RATIO_WH = r => r.split(':').map(Number);

/* ---------- State ---------- */
const prefs = (() => { try { return JSON.parse(localStorage.getItem('aps-prefs') || '{}'); } catch { return {}; } })();
const state = {
    provider: prefs.provider || 'google', model: prefs.model || null, ratio: prefs.ratio || '1:1', count: prefs.count || 1,
    opts: prefs.opts || {}, genCollapsed: !!prefs.genCollapsed,
    refs: [], images: [], collections: [], providers: {}, jobs: [], ratios: ['1:1', '4:5', '3:2', '2:3', '16:9', '9:16'],
    view: 'all', selected: new Set(), current: null, zoom: false, provOpen: false, provSub: 'google', loaded: false,
    enabled: null, modelFilter: ''
};
function savePrefs() {
    try {
        localStorage.setItem('aps-prefs', JSON.stringify({
            provider: state.provider, model: state.model, ratio: state.ratio, count: state.count, opts: state.opts,
            genCollapsed: state.genCollapsed, colw: document.documentElement.style.getPropertyValue('--colw') || ''
        }));
    } catch { /* storage unavailable */ }
}
if (prefs.colw) document.documentElement.style.setProperty('--colw', prefs.colw);

async function api(method, url, body, signal) {
    const res = await fetch(url, { method, signal, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = {};
    try { j = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
    return j;
}

/* ---------- Helpers ---------- */
const col = id => state.collections.find(c => c.id === id);
const isCol = v => !!col(v);
const prov = id => state.providers[id] || { name: id, models: [] };
const modelsOf = p => prov(p).models || [];
const findModel = (p, id) => modelsOf(p).find(m => m.id === id);
const modelName = (p, id) => findModel(p, id)?.name || id;
const curModel = () => state.model ? findModel(state.provider, state.model) : null;

/* Enabled models: the ones ticked in Providers, which are all the Generate panel lists.
   Until the first tick, the top two Google and OpenAI models are enabled. */
function enabledIds(pid) {
    const listed = modelsOf(pid).map(m => m.id);
    if (state.enabled) return (state.enabled[pid] || []).filter(id => listed.includes(id));
    return pid === 'openrouter' ? [] : listed.slice(0, 2);
}
const isEnabled = (pid, id) => enabledIds(pid).includes(id);
const enabledModels = pid => modelsOf(pid).filter(m => isEnabled(pid, m.id));
/** Keeps the chosen model on an enabled one (the current provider's first, then any). */
function ensureModel() {
    if (state.model && isEnabled(state.provider, state.model)) return;
    const loading = PROV_ORDER.some(p => prov(p).fetching);
    if (state.model && findModel(state.provider, state.model) && loading) return;
    const pick = enabledModels(state.provider)[0] ? [state.provider, enabledModels(state.provider)[0]]
        : PROV_ORDER.map(p => [p, enabledModels(p)[0]]).find(([, m]) => m);
    if (pick) { state.provider = pick[0]; state.model = pick[1].id; }
    else if (!loading) state.model = null;
}
let settingsSave = Promise.resolve();
function toggleEnabled(pid, id) {
    const next = {};
    for (const p of PROV_ORDER) next[p] = enabledIds(p);
    next[pid] = next[pid].includes(id) ? next[pid].filter(x => x !== id) : [...next[pid], id];
    // Keep ids of models that aren't listed right now (e.g. a list that failed to load).
    if (state.enabled) for (const p of PROV_ORDER) for (const x of state.enabled[p] || []) if (!next[p].includes(x) && !findModel(p, x)) next[p].push(x);
    state.enabled = next;
    ensureModel(); savePrefs(); renderGen();
    settingsSave = settingsSave.then(() => api('POST', '/api/settings', { enabledModels: next })).catch(fail);
}
/** The chosen settings (size, quality, thinking) for a model, falling back to its defaults. */
function curOptions(m) {
    const saved = state.opts[m?.id];
    const out = {};
    for (const o of m?.options || []) {
        const v = saved && typeof saved === 'object' ? saved[o.key] : null;
        out[o.key] = o.values.includes(v) ? v : o.default;
    }
    return out;
}
const OPTION_LABELS = { size: 'Size', quality: 'Quality', thinking: 'Thinking' };
const imgSrc = it => `/images/${it.file}`;
const ago = ts => {
    const s = (Date.now() - ts) / 1000;
    if (s < 50) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago';
};
const inView = (it, v = state.view) => v === 'all' ? true : v === 'unsorted' ? !it.collection : it.collection === v;
const done = () => state.images.filter(it => inView(it));
const curItem = () => state.images.find(i => i.id === state.current);
let toastT;
function toast(msg, icon = 'check') {
    clearTimeout(toastT);
    $('#toastHost').innerHTML = `<div id="toast" role="status">${fa(icon)}<span>${esc(msg)}</span></div>`;
    toastT = setTimeout(() => { $('#toastHost').innerHTML = ''; }, 3200);
}
const fail = err => toast(err.message || String(err), 'triangle-exclamation');
const dayKey = ts => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
function dayLabel(ts) {
    const now = new Date(), d = new Date(ts);
    if (dayKey(ts) === dayKey(now)) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(ts) === dayKey(y)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const typing = () => { const a = document.activeElement; return a && /INPUT|TEXTAREA/.test(a.tagName) && a.id !== 'send_textarea'; };

/* ---------- Gallery ---------- */
let armedDel = false, newColOpen = false, renamingView = false, colArmed = false;
function renderGallery() {
    const v = state.view, c = col(v);
    if (!c && v !== 'all' && v !== 'unsorted') state.view = 'all';
    const title = state.view === 'all' ? 'All images' : state.view === 'unsorted' ? 'Unsorted' : c.name;
    const icon = state.view === 'all' ? fa('table-cells-large') : state.view === 'unsorted' ? fa('inbox') : `<span class="swatch" style="--c:${c.rgb}"></span>`;
    const n = done().length;
    let right;
    if (state.selected.size) {
        const opts = [['unsorted', 'Unsorted'], ...state.collections.map(c => [c.id, c.name])].map(([id, nm]) => `<option value="${id}">${esc(nm)}</option>`).join('');
        right = `<div class="selbar"><span class="count">${state.selected.size} selected</span>
      <label for="moveSel" hidden>Move to collection</label><select id="moveSel"><option value="">Move to…</option>${opts}</select>
      <button class="menu_button" data-act="sel-ref">${fa('images')}References</button>
      <button class="menu_button danger ${armedDel ? 'armed' : ''}" data-act="sel-del">${fa('trash-can')}${armedDel ? 'Confirm' : 'Delete'}</button>
      <button class="cp-btn" data-act="sel-clear" title="Clear selection" aria-label="Clear selection">${fa('xmark')}</button></div>`;
    } else if (renamingView) {
        right = `<div class="cp-btns"><button class="menu_button primary" data-act="col-rename-ok">${fa('check')}Save</button><button class="cp-btn" data-act="col-rename-cancel" title="Cancel" aria-label="Cancel">${fa('xmark')}</button></div>`;
    } else {
        const colBtns = c ? `<button class="cp-btn" data-act="col-rename" title="Rename collection" aria-label="Rename collection">${fa('pen')}</button>
      ${colArmed ? `<button class="menu_button danger armed" data-act="col-del">${fa('trash-can')}Delete collection? Images go to Unsorted</button>` : `<button class="cp-btn" data-act="col-del" title="Delete collection" aria-label="Delete collection">${fa('trash-can')}</button>`}<span style="width:6px"></span>` : '';
        right = `<div class="cp-btns">${colBtns}<span class="cp-btns zoom-btns"><button class="cp-btn" data-act="zoom-out" title="Smaller tiles" aria-label="Smaller tiles">${fa('magnifying-glass-minus')}</button><button class="cp-btn" data-act="zoom-in" title="Bigger tiles" aria-label="Bigger tiles">${fa('magnifying-glass-plus')}</button></span></div>`;
    }
    const titleHTML = renamingView && c
        ? `<span class="cp-title">${icon}<label for="renameInput" hidden>Collection name</label><input class="text_pole" id="renameInput" value="${esc(c.name)}" maxlength="60"></span>`
        : `<span class="cp-title">${icon}<span>${esc(title)}</span><span class="cp-count">${n}</span></span>`;
    const count = vv => state.images.filter(it => inView(it, vv)).length;
    const pill = (vv, label, lead, drop) => `<button class="room-item" type="button" data-act="view" data-v="${vv}" ${drop ? 'data-drop="1"' : ''} aria-pressed="${state.view === vv}">${lead}<span>${esc(label)}</span><span class="n">${count(vv)}</span></button>`;
    const newCol = newColOpen
        ? `<span class="new-col"><label for="newColName" hidden>New collection name</label><input class="text_pole" id="newColName" placeholder="Collection name" maxlength="60"><button class="cp-btn" data-act="new-col-ok" title="Create" aria-label="Create collection" style="height:30px;width:30px">${fa('check')}</button><button class="cp-btn" data-act="new-col-cancel" title="Cancel" aria-label="Cancel" style="height:30px;width:30px">${fa('xmark')}</button></span>`
        : `<button class="room-item" type="button" data-act="new-col" title="New collection">${fa('plus')}<span>New collection</span></button>`;
    $('#gHead').innerHTML = `<div class="cp-header">${titleHTML}${right}</div>
    <div class="room-items" role="toolbar" aria-label="Collections">
      ${pill('all', 'All images', fa('table-cells-large'))}${pill('unsorted', 'Unsorted', fa('inbox'), true)}
      ${state.collections.map(c => pill(c.id, c.name, `<span class="swatch" style="--c:${c.rgb}"></span>`, true)).join('')}
      ${newCol}
    </div>`;

    const days = $('#days');
    days.classList.toggle('selecting', state.selected.size > 0);
    const jobs = state.jobs.filter(j => inView(j));
    const list = done();
    if (!list.length && !jobs.length) {
        const cc = col(state.view);
        days.innerHTML = state.view === 'all'
            ? `<div class="empty"><b>No images yet</b>Write a prompt below and press Enter. Add a key under Providers (the plug button) first.</div>`
            : `<div class="empty"><b>${cc ? `Nothing in ${esc(cc.name)} yet` : 'No unsorted images'}</b>${cc ? 'Drag images onto its name above, or generate while it is open and new images land here.' : 'Images you generate from All images or Unsorted stay here until you file them.'}</div>`;
    } else {
        const groups = [];
        if (jobs.length) groups.push({ k: 'jobs', ts: Date.now(), items: [], jobs });
        list.forEach(it => {
            const k = dayKey(it.created);
            let g = groups[groups.length - 1];
            if (!g || (g.k !== k && !(g.k === 'jobs' && k === dayKey(Date.now())))) groups.push(g = { k, ts: it.created, items: [] });
            if (g.k === 'jobs') g.k = k;
            g.items.push(it);
        });
        days.innerHTML = groups.map(g => {
            const n = g.items.length + (g.jobs ? g.jobs.length : 0);
            return `<section class="day"><div class="day-h"><span>${dayLabel(g.ts)}</span><span class="mono">${n}</span></div><div class="cards">${(g.jobs || []).map(jobHTML).join('')}${g.items.map(cardHTML).join('')}</div></section>`;
        }).join('');
    }
    state.images.forEach(i => { i.fresh = false; });
}
function aspect(it) {
    if (it.width && it.height) return `${it.width}/${it.height}`;
    const [a, b] = RATIO_WH(it.ratio || '1:1'); return `${a}/${b}`;
}
function jobHTML(j) {
    const c = state.view === 'all' && j.collection ? col(j.collection) : null;
    const tag = c ? `<span class="swatch" style="--c:${c.rgb}" title="${esc(c.name)}"></span>` : '';
    if (j.status === 'error') return `<article class="sq failed" style="--p:${PROV_RGB[j.provider]}">
      <div class="pic err" style="aspect-ratio:${aspect(j)}">${fa('triangle-exclamation')}<p>${esc(j.error)}</p>
        <div class="panel-row"><button class="menu_button" data-act="retry" data-tid="${j.tid}">${fa('rotate-right')}Retry</button><button class="menu_button" data-act="dismiss" data-tid="${j.tid}">Dismiss</button></div></div>
      <div class="name">${esc(j.prompt || 'Variation of the reference image')}</div>
      <div class="sub"><span class="pdot"></span><span>${esc(j.modelName)} · failed</span><span class="grow"></span>${tag}</div></article>`;
    return `<article class="sq pending" style="--p:${PROV_RGB[j.provider]}">
    <div class="pic shimmer" style="aspect-ratio:${aspect(j)}"><div class="pend"><span class="spin"></span><span class="mono" data-elapsed="${j.started}">0s</span></div>
      <button class="ov-btn x" data-act="cancel" data-tid="${j.tid}" title="Cancel" aria-label="Cancel">${fa('xmark')}</button></div>
    <div class="name">${esc(j.prompt || 'Variation of the reference image')}</div>
    <div class="sub"><span class="pdot"></span><span>Generating · ${esc(j.modelName)} · ${j.ratio}</span><span class="grow"></span>${tag}</div></article>`;
}
function cardHTML(it) {
    const c = state.view === 'all' && it.collection ? col(it.collection) : null;
    const tag = c ? `<span class="swatch" style="--c:${c.rgb}" title="${esc(c.name)}"></span>` : '';
    const sel = state.selected.has(it.id);
    return `<article class="sq${sel ? ' sel' : ''}${state.current === it.id ? ' active' : ''}${it.fresh ? ' fresh' : ''}" draggable="true" data-id="${it.id}" style="--p:${PROV_RGB[it.provider] || '160 174 192'}">
    <div class="pic" style="aspect-ratio:${aspect(it)}">
      <img src="${imgSrc(it)}" alt="${esc(it.prompt)}" loading="lazy" decoding="async" draggable="false">
      <button class="open" data-act="open" data-id="${it.id}" aria-label="Open: ${esc(it.prompt)}" title="${esc(it.prompt)}"></button>
      <button class="ov-btn chk" data-act="sel" data-id="${it.id}" aria-pressed="${sel}" aria-label="Select" title="Select">${fa('check')}</button>
      <button class="ov-btn ref" data-act="ref" data-id="${it.id}" aria-label="Use as reference" title="Use as reference">${fa('images')}</button>
    </div>
    <div class="name">${esc(it.prompt || 'Variation of the reference image')}</div>
    <div class="sub"><span class="pdot" title="${esc(prov(it.provider).name)}"></span><span>${esc(modelName(it.provider, it.model))}${it.refs?.length ? ` · ${it.refs.length} ref` : ''}</span><span class="grow"></span>${tag}<time>${ago(it.created)}</time></div>
  </article>`;
}

/* ---------- Generate panel and send bar ---------- */
function renderGen() {
    const P = prov(state.provider), m = curModel();
    const running = state.jobs.filter(j => j.status === 'pending').length;
    const ratios = m ? m.ratios : state.ratios;
    if (!ratios.includes(state.ratio)) state.ratio = ratios.includes('1:1') ? '1:1' : ratios[0];
    const groups = PROV_ORDER.map(pid => {
        const Pr = prov(pid), list = enabledModels(pid);
        if (!list.length) return '';
        const opts = list.map(mm => `<option value="${pid}|${esc(mm.id)}" ${state.provider === pid && state.model === mm.id ? 'selected' : ''}>${esc(mm.name)}</option>`).join('');
        return `<optgroup label="${esc(Pr.name)}${Pr.hasKey ? '' : ' · no key'}">${opts}</optgroup>`;
    }).join('') || `<option disabled>${PROV_ORDER.some(p => prov(p).fetching) ? 'Loading models…' : 'No models enabled'}</option>`;
    const noneEnabled = !PROV_ORDER.some(p => enabledModels(p).length) && !PROV_ORDER.some(p => prov(p).fetching);
    let hint;
    if (noneEnabled) hint = `<span class="status-dot" data-state="error"></span><span>No models enabled · <button type="button" data-act="providers">Choose some</button></span>`;
    else if (!P.hasKey) hint = `<span class="status-dot" data-state="error"></span><span>No ${esc(P.name)} key · <button type="button" data-act="providers">Add one</button></span>`;
    else if (m && m.acceptsImages === false && state.refs.length) hint = `<span class="status-dot" data-state="loading"></span><span>This model ignores reference images</span>`;
    else hint = `<span class="pdot" style="--p:${PROV_RGB[state.provider]}"></span><span>${esc(P.name)}${m ? ` · <span class="mono">${esc(m.id)}</span>` : ''}</span>`;
    const refs = state.refs.map(r => `<div class="mini-sq" title="${esc(r.name)}"><img src="${esc(r.src)}" alt="${esc(r.name)}"><div class="nm">${esc(r.short)}</div><button type="button" class="rm" data-act="rm-ref" data-id="${r.id}" aria-label="Remove reference">${fa('xmark')}</button></div>`).join('');
    const c = state.genCollapsed;
    const chosen = curOptions(m);
    const optTitles = { thinking: { openai: 'How much the model plans before drawing (complexity)', google: 'How much the model reasons before drawing (thinking level)', openrouter: 'Reasoning effort; auto leaves it to the model' }[state.provider] };
    const opt = (m?.options || []).map(o => `<div class="room-items opt-row" role="group" aria-label="${esc(o.label)}" title="${esc(optTitles[o.key] || o.label)}"><span class="opt-label">${esc(o.label)}</span>${o.values.map(v => `<button type="button" class="room-item opt" data-act="opt" data-k="${esc(o.key)}" data-v="${esc(v)}" aria-pressed="${chosen[o.key] === v}">${esc(v)}</button>`).join('')}</div>`).join('');
    $('#gen').classList.toggle('collapsed', c);
    $('#gen').innerHTML = `<div class="cp-header" data-act="gen-toggle">
      <span class="cp-title">${fa('wand-magic-sparkles')}<span>Generate</span><span class="cp-count">${running ? running + ' running' : esc(m ? m.name : 'Pick a model')}</span></span>
      <div class="cp-btns">
        <button type="button" class="cp-btn" data-act="attach" title="Attach reference images" aria-label="Attach reference images">${fa('paperclip')}</button>
        <button type="button" class="cp-btn" data-act="providers" title="Providers and keys" aria-label="Providers and keys">${fa('plug')}</button>
        <button type="button" class="cp-btn" data-act="gen-toggle" aria-expanded="${!c}" title="${c ? 'Show' : 'Hide'} options" aria-label="${c ? 'Show' : 'Hide'} options">${fa(c ? 'chevron-up' : 'chevron-down')}</button>
      </div></div>
    <div class="cp-body" ${c ? 'hidden' : ''}>
      <div class="section model" style="--c:var(--gold-rgb)"><span class="section-label">Model</span>
        <label for="modelSel" hidden>Model</label><select id="modelSel">${m ? '' : '<option selected disabled>Pick a model</option>'}${groups}</select>
        <span class="sec-hint">${hint}</span></div>
      <div class="section refs" style="--c:var(--nearby-rgb)"><span class="section-label">References <span class="mono">${state.refs.length}</span></span>
        <div class="squares">${refs}<button type="button" class="add-sq" data-act="attach" title="Attach reference images">${fa('plus')}Add</button>
        ${state.refs.length ? '' : '<span class="refs-empty">Drop, paste or attach images, or drag them in from the gallery, to edit or combine them.</span>'}</div></div>
      <div class="section out" style="--c:var(--green-rgb)"><span class="section-label">Output</span>
        <div class="room-items" role="group" aria-label="Aspect ratio">${ratios.map(r => `<button type="button" class="room-item" data-act="ratio" data-r="${r}" aria-pressed="${state.ratio === r}">${r}</button>`).join('')}</div>
        <div class="room-items" role="group" aria-label="Number of images">${[1, 2, 3, 4].map(n => `<button type="button" class="room-item" data-act="count" data-n="${n}" aria-pressed="${state.count === n}">×${n}</button>`).join('')}</div>
        ${opt}</div>
    </div>`;
    renderSend();
}
function renderSend() {
    const P = prov(state.provider), m = curModel();
    $('#genN').textContent = state.count > 1 ? '×' + state.count : '';
    $('#genBtn').title = P.hasKey ? `Generate ${state.count} image${state.count > 1 ? 's' : ''}${m ? ' with ' + m.name : ''} (Enter)` : `Add a ${P.name} key first`;
    $('#toggleDot').dataset.state = P.hasKey ? 'ready' : 'error';
}

/* ---------- Providers dialog ---------- */
/** Draws the dialog once, then only refreshes its contents, so switching tabs or a
 *  finished model fetch never re-runs the dialog's open animation. `swap` crossfades the
 *  page when the provider tab changes. */
function renderProviders(swap = false) {
    const host = $('#modalHost');
    if (!state.provOpen) { host.innerHTML = ''; return; }
    let body = host.querySelector('.modal-body');
    if (!body) {
        host.innerHTML = `<div class="modal-wrap" data-act="prov-scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="provTitle">
    <div class="modal-head"><span class="cp-title" id="provTitle">${fa('plug')}<span>Providers</span></span><button class="cp-btn" data-act="prov-close" title="Close" aria-label="Close">${fa('xmark')}</button></div>
    <div class="modal-body"></div></div></div>`;
        body = host.querySelector('.modal-body');
    }
    const keyVal = !swap ? host.querySelector('#keyInput')?.value || '' : '';
    body.innerHTML = providersPage();
    if (keyVal) host.querySelector('#keyInput').value = keyVal;
    if (swap) {
        const page = body.querySelector('.panel-page');
        page.classList.remove('swap'); void page.offsetWidth; page.classList.add('swap');
    }
}
function providersPage() {
    const pid = state.provSub, P = prov(pid);
    const dot = Pr => !Pr.hasKey ? 'error' : Pr.fetching ? 'loading' : Pr.error ? 'error' : 'ready';
    const sub = PROV_ORDER.map(id => `<button type="button" role="tab" data-act="prov-sub" data-p="${id}" aria-selected="${id === pid}"><span class="status-dot" data-state="${dot(prov(id))}"></span><span>${esc(prov(id).name)}</span></button>`).join('');
    const st = dot(P);
    const n = P.models?.length || 0;
    let stText;
    if (!P.hasKey) stText = pid === 'openrouter' ? `No key saved. The model list is public, but generating needs a key.` : 'No key saved. Add one to generate with these models.';
    else if (P.fetching) stText = 'Loading image models…';
    else if (P.error) stText = `Couldn't list models: ${P.error}`;
    else stText = `Key saved (${esc(P.keyHint)}) · ${n} image model${n === 1 ? '' : 's'}`;
    const srcNote = P.source === 'builtin' && pid !== 'openrouter' ? '<p class="panel-hint">Showing the built-in list. Save a key to load the models your account can use.</p>' : '';
    const on = enabledIds(pid).length;
    const filter = state.modelFilter.toLowerCase();
    const rows = (P.models || []).map(m => {
        const hide = filter && !`${m.name} ${m.id}`.toLowerCase().includes(filter);
        const inUse = state.provider === pid && state.model === m.id;
        return `<button type="button" class="list-row" role="checkbox" aria-checked="${isEnabled(pid, m.id)}" data-act="toggle-model" data-p="${pid}" data-m="${esc(m.id)}" data-search="${esc(`${m.name} ${m.id}`.toLowerCase())}" ${hide ? 'hidden' : ''}>
        <span class="tick">${fa('check')}</span><span class="t"><b>${esc(m.name)}</b><code>${esc(m.id)}</code></span>${inUse ? '<span class="in-use">In use</span>' : ''}<span class="note">${esc(m.note || '')}</span></button>`;
    }).join('');
    const list = n ? `<div class="list-tools">
        ${n > 6 ? `<label for="modelFilter" hidden>Filter models</label><input class="text_pole" id="modelFilter" type="search" placeholder="Filter ${n} models" value="${esc(state.modelFilter)}" autocomplete="off">` : ''}
        <span class="count" id="enabledCount">${on} of ${n} in Generate</span>
        ${on ? `<button class="menu_button" data-act="models-clear" title="Untick all ${esc(P.name)} models">Untick all</button>` : ''}
      </div>
      <p class="panel-hint">Tick the models you want to choose from in Generate.</p>
      <div class="list" role="group" aria-label="${esc(P.name)} models">${rows}<div class="list-empty" id="filterEmpty" hidden>No models match.</div></div>` : '';
    const extra = pid === 'openai' ? '<p class="panel-hint">GPT Image 2 and newer make any ratio up to 21:9 at 1K, 2K or 4K (above 2560×1440 is experimental). Older models make 1:1, 3:2 and 2:3 only. Thinking sets how much 2.5 and 2.6 plan before drawing. gpt-image-1 was shut down on 23 October 2026.</p>'
        : pid === 'google' ? '<p class="panel-hint">Nano Banana models take up to 14 reference images, so a prompt can edit or combine pictures. Thinking sets how much 2.1, 2 and 2 Lite reason before drawing; Pro always thinks.</p>'
            : '<p class="panel-hint">Lists every OpenRouter model whose output includes images.</p>';
    return `<div class="panel-subtabs" role="tablist">${sub}</div><div class="panel-page">
    <div class="panel-label"><label for="keyInput">API key</label></div>
    <div class="panel-row"><input class="text_pole mono" id="keyInput" type="password" placeholder="${P.hasKey ? `Saved: ${esc(P.keyHint)} · paste a new key to replace it` : `Paste your ${esc(P.name)} key`}" spellcheck="false" autocomplete="off">
      <button class="menu_button" data-act="peek" title="Show key" aria-label="Show key">${fa('eye')}</button>
      <button class="menu_button primary" data-act="key-save">Save</button>
      ${P.hasKey ? `<button class="menu_button danger" data-act="key-remove" title="Remove key">${fa('trash-can')}</button>` : ''}</div>
    <p class="panel-hint">Get one at <a href="${KEY_HELP[pid][0]}" target="_blank" rel="noopener">${KEY_HELP[pid][1]}</a>. Saved on this computer in <span class="mono">data/keys.json</span>; the local server makes every call, so the key never reaches the browser.</p>
    <div class="connection-status"><span class="status-dot" data-state="${st}"></span><span data-state="${st}">${esc(stText)}</span></div>
    <div class="panel-label">Image models</div>
    <div class="panel-row"><button class="menu_button" data-act="refresh-models" ${P.fetching ? 'disabled' : ''}>${fa('rotate-right', P.fetching ? 'fa-spin' : '')}Refresh list</button>${P.fetchedAt ? `<span class="panel-hint">Loaded ${ago(P.fetchedAt)}</span>` : ''}</div>
    ${srcNote}${list}${extra}
  </div>`;
}

/* ---------- Viewer ---------- */
let curArmed = false;
function renderViewer() {
    const it = curItem();
    if (!state.zoom || !it) { $('#lightbox').innerHTML = ''; state.zoom = false; return; }
    const P = prov(it.provider);
    const list = done(), idx = list.findIndex(i => i.id === it.id), d = new Date(it.created);
    const opts = [['', 'Unsorted'], ...state.collections.map(c => [c.id, c.name])].map(([id, nm]) => `<option value="${id}" ${(it.collection || '') === id ? 'selected' : ''}>${esc(nm)}</option>`).join('');
    const optRows = Object.entries(it.options || (it.option ? { size: it.option } : {}))
        .map(([k, v]) => `<dt>${esc(OPTION_LABELS[k] || k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#lightbox').innerHTML = `<div class="lb" role="dialog" aria-modal="true" aria-label="Image" style="--p:${PROV_RGB[it.provider]}">
    <div class="lb-stage" data-act="zoom-scrim">
      <img src="${imgSrc(it)}" alt="${esc(it.prompt)}">
      <button class="menu_button prev" data-act="cur-step" data-d="-1" aria-label="Previous image">${fa('chevron-left')}</button>
      <button class="menu_button next" data-act="cur-step" data-d="1" aria-label="Next image">${fa('chevron-right')}</button>
    </div>
    <aside class="lb-info">
      <div class="lb-info-head"><span class="cp-title"><span class="pdot"></span><span>${esc(modelName(it.provider, it.model))}</span><span class="cp-count">${idx >= 0 ? `${idx + 1} / ${list.length}` : ''}</span></span><button class="cp-btn" data-act="zoom-close" title="Close (Esc)" aria-label="Close">${fa('xmark')}</button></div>
      <div class="panel-page">
        <div class="panel-label">Prompt</div>
        <p class="prompt-box" id="promptBox">${esc(it.prompt || '(no prompt: a variation of the references)')}</p>
        <div class="panel-row"><button class="menu_button" data-act="copy">${fa('copy')}Copy</button><button class="menu_button" data-act="reuse">${fa('rotate-left')}Reuse prompt</button><button class="menu_button" data-act="cur-ref">${fa('images')}Use as reference</button></div>
        <div class="panel-label">Details</div>
        <dl class="details">
          <dt>Provider</dt><dd>${esc(P.name)}</dd>
          <dt>Model ID</dt><dd class="mono">${esc(it.model)}</dd>
          <dt>Size</dt><dd>${it.width ? `${it.width} × ${it.height}` : 'Unknown'} · ${esc(it.ratio)}</dd>
          ${optRows}
          <dt>Created</dt><dd>${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${it.seconds ? ` · took ${it.seconds} s` : ''}</dd>
          <dt>File</dt><dd class="mono">data/images/${esc(it.file)}</dd>
        </dl>
        ${it.refs?.length ? `<div class="panel-label">References</div><div class="ref-strip">${it.refs.map(r => `<img src="${esc(r)}" alt="Reference image">`).join('')}</div>` : ''}
        <div class="panel-label"><label for="curCol">Collection</label></div>
        <select id="curCol" class="full">${opts}</select>
        <div class="panel-row" style="margin-top:14px"><a class="menu_button" href="/api/images/${it.id}/download" download>${fa('download')}Download</a><span class="grow"></span><button class="menu_button danger ${curArmed ? 'armed' : ''}" data-act="cur-del">${fa('trash-can')}${curArmed ? 'Confirm delete' : 'Delete'}</button></div>
      </div>
    </aside></div>`;
}
function step(dir) {
    const list = done(); if (!list.length) return;
    const idx = list.findIndex(i => i.id === state.current);
    state.current = list[(idx + dir + list.length) % list.length].id; curArmed = false;
    renderGallery(); renderViewer();
    document.querySelector(`.sq[data-id="${state.current}"]`)?.scrollIntoView({ block: 'nearest' });
}
function closeViewer() { state.zoom = false; renderViewer(); }
function renderAll() { renderGallery(); renderGen(); renderProviders(); renderViewer(); }

/* ---------- Models ---------- */
async function loadModels(pid, refresh = false) {
    const P = state.providers[pid];
    if (!P) return;
    P.fetching = true; renderGen(); if (state.provOpen && !typing()) renderProviders();
    try {
        const r = await api('GET', `/api/models/${pid}${refresh ? '?refresh=1' : ''}`);
        Object.assign(P, { models: r.models, source: r.source, error: r.error, fetchedAt: r.fetchedAt });
    } catch (err) {
        P.error = err.message;
    }
    P.fetching = false;
    ensureModel();
    renderGen(); if (state.provOpen && !typing()) renderProviders();
}

/* ---------- Actions ---------- */
function addRef(ref) {
    const name = ref.name || 'Image';
    state.refs.push({ id: uid(), short: name.length > 14 ? name.slice(0, 13) + '…' : name, ...ref, name });
    if (state.genCollapsed) state.genCollapsed = false;
    renderGen();
}
const refFromImage = it => addRef({ imageId: it.id, src: imgSrc(it), name: it.prompt || 'Image' });
function addFiles(files) {
    const imgs = [...files].filter(f => f.type.startsWith('image/'));
    const big = imgs.filter(f => f.size > 25 * 1024 * 1024);
    if (big.length) toast(`${big.length} image${big.length > 1 ? 's are' : ' is'} over 25 MB and ${big.length > 1 ? 'were' : 'was'} skipped`, 'triangle-exclamation');
    imgs.filter(f => f.size <= 25 * 1024 * 1024).forEach(f => {
        const r = new FileReader();
        r.onload = () => addRef({ dataUrl: r.result, src: r.result, name: f.name });
        r.readAsDataURL(f);
    });
    if (imgs.length - big.length > 0) toast(`Attached ${imgs.length - big.length} reference image${imgs.length - big.length > 1 ? 's' : ''}`, 'paperclip');
}
function openProviders(pid) { state.provSub = pid || state.provider; state.provOpen = true; renderProviders(); }

function runJob(job) {
    job.status = 'pending'; job.error = null; job.started = Date.now(); job.ctrl = new AbortController();
    api('POST', '/api/generate', job.body, job.ctrl.signal).then(rec => {
        state.jobs = state.jobs.filter(j => j !== job);
        rec.fresh = true;
        state.images.unshift(rec);
        if (!typing()) renderGallery();
        renderGen();
    }).catch(err => {
        if (job.ctrl.signal.aborted) return;
        job.status = 'error'; job.error = err.message;
        if (!typing()) renderGallery();
        renderGen();
    });
}
function generate() {
    const ta = $('#send_textarea'), text = ta.value.trim();
    const P = prov(state.provider), m = curModel();
    if (!P.hasKey) { openProviders(state.provider); setTimeout(() => $('#keyInput')?.focus()); toast(`Add a ${P.name} key to generate${m ? ' with ' + m.name : ''}`, 'key'); return; }
    if (!m) { state.genCollapsed = false; renderGen(); $('#modelSel').focus(); return; }
    if (!text && !state.refs.length) { const f = $('#send_form'); f.classList.remove('prompt-shake'); void f.offsetWidth; f.classList.add('prompt-shake'); ta.focus(); return; }
    const target = isCol(state.view) ? state.view : null;
    const refs = state.refs.map(r => r.imageId ? { imageId: r.imageId } : { dataUrl: r.dataUrl });
    const options = curOptions(m);
    for (let i = 0; i < state.count; i++) {
        const job = {
            tid: uid(), prompt: text, provider: state.provider, model: m.id, modelName: m.name, ratio: state.ratio, collection: target,
            body: { provider: state.provider, model: m.id, prompt: text, ratio: state.ratio, options, collection: target, refs }
        };
        state.jobs.unshift(job);
        runJob(job);
    }
    savePrefs();
    $('#gallery').scrollTo({ top: 0, behavior: 'smooth' });
    renderGallery(); renderGen();
}
async function moveTo(ids, target) {
    const c = target === 'unsorted' || !target ? null : target;
    ids.forEach(id => { const it = state.images.find(i => i.id === id); if (it) it.collection = c; });
    toast(`Moved ${ids.length} image${ids.length > 1 ? 's' : ''} to ${c ? col(c).name : 'Unsorted'}`, 'folder-open');
    try { await api('PATCH', '/api/images', { ids, collection: c }); } catch (err) { fail(err); reload(); }
}
async function deleteImages(ids) {
    state.images = state.images.filter(i => !ids.includes(i.id));
    ids.forEach(id => state.selected.delete(id));
    state.refs = state.refs.filter(r => !ids.includes(r.imageId));
    try { await api('DELETE', '/api/images', { ids }); } catch (err) { fail(err); reload(); }
}
async function createCol() {
    const inp = $('#newColName'); const name = inp && inp.value.trim();
    if (!name) { inp && inp.focus(); return; }
    try {
        const c = await api('POST', '/api/collections', { name });
        state.collections.push(c);
        newColOpen = false;
        if (state.selected.size) { await moveTo([...state.selected], c.id); state.selected.clear(); }
        else toast(`Created ${name}`, 'folder-open');
        state.view = c.id; renderGallery();
    } catch (err) { fail(err); }
}
async function renameCol() {
    const v = $('#renameInput').value.trim(), c = col(state.view);
    renamingView = false;
    if (v && c && v !== c.name) {
        c.name = v;
        try { await api('PATCH', `/api/collections/${c.id}`, { name: v }); } catch (err) { fail(err); reload(); }
    }
    renderGallery();
}
async function reload() {
    try {
        const s = await api('GET', '/api/state');
        state.images = s.images; state.collections = s.collections; state.ratios = s.ratios || state.ratios;
        state.enabled = s.settings?.enabledModels || state.enabled;
        for (const [id, p] of Object.entries(s.providers)) state.providers[id] = Object.assign(state.providers[id] || { models: [] }, p);
        renderAll();
    } catch (err) { fail(err); }
}
function selectPrompt() { const p = $('#promptBox'); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Prompt selected. Press Ctrl+C to copy.', 'copy'); }
async function saveKey(pid, key) {
    try {
        const r = await api('POST', '/api/keys', { provider: pid, key });
        Object.assign(state.providers[pid], { hasKey: r.hasKey, keyHint: r.keyHint, error: null });
        toast(key ? `${prov(pid).name} key saved` : `${prov(pid).name} key removed`, 'key');
        renderProviders(); renderGen();
        loadModels(pid, true);
    } catch (err) { fail(err); }
}

document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    const it = id && state.images.find(i => i.id === id);
    const job = el.dataset.tid && state.jobs.find(j => j.tid === el.dataset.tid);
    const cur = curItem();
    switch (act) {
        case 'providers': openProviders(); break;
        case 'prov-close': state.provOpen = false; renderProviders(); break;
        case 'prov-scrim': if (e.target === el) { state.provOpen = false; renderProviders(); } break;
        case 'prov-sub': if (state.provSub !== el.dataset.p) { state.provSub = el.dataset.p; state.modelFilter = ''; renderProviders(true); } break;
        case 'gen-toggle': state.genCollapsed = !state.genCollapsed; savePrefs(); renderGen(); break;
        case 'attach': $('#fileInput').click(); break;
        case 'rm-ref': state.refs = state.refs.filter(r => r.id !== id); renderGen(); break;
        case 'ratio': state.ratio = el.dataset.r; savePrefs(); renderGen(); break;
        case 'count': state.count = +el.dataset.n; savePrefs(); renderGen(); break;
        case 'opt': {
            const m = curModel();
            if (m) { state.opts[m.id] = { ...curOptions(m), [el.dataset.k]: el.dataset.v }; savePrefs(); renderGen(); }
            break;
        }
        case 'view': state.view = el.dataset.v; state.selected.clear(); armedDel = false; renamingView = false; colArmed = false; renderGallery(); $('#gallery').scrollTop = 0; break;
        case 'new-col': newColOpen = true; renderGallery(); setTimeout(() => $('#newColName')?.focus()); break;
        case 'new-col-ok': createCol(); break;
        case 'new-col-cancel': newColOpen = false; renderGallery(); break;
        case 'col-rename': renamingView = true; colArmed = false; renderGallery(); setTimeout(() => { const r = $('#renameInput'); r?.focus(); r?.select(); }); break;
        case 'col-rename-ok': renameCol(); break;
        case 'col-rename-cancel': renamingView = false; renderGallery(); break;
        case 'col-del':
            if (!colArmed) { colArmed = true; renderGallery(); break; }
            {
                const c = col(state.view);
                state.images.forEach(i => { if (i.collection === c.id) i.collection = null; });
                state.collections = state.collections.filter(x => x.id !== c.id); state.view = 'unsorted'; colArmed = false; renderGallery();
                toast(`Deleted ${c.name}. Its images are in Unsorted.`, 'trash-can');
                api('DELETE', `/api/collections/${c.id}`).catch(err => { fail(err); reload(); });
            }
            break;
        case 'zoom-in': case 'zoom-out': {
            const cs = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--colw')) || 210;
            const nv = Math.max(130, Math.min(480, cs + (act === 'zoom-in' ? 40 : -40)));
            document.documentElement.style.setProperty('--colw', nv + 'px'); savePrefs(); break;
        }
        case 'open': if (it) { state.current = id; state.zoom = true; curArmed = false; renderGallery(); renderViewer(); } break;
        case 'sel': state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id); armedDel = false; renderGallery(); break;
        case 'ref': if (it) { refFromImage(it); toast('Added as a reference. Describe the change you want.', 'images'); $('#send_textarea').focus(); } break;
        case 'cancel': if (job) { job.ctrl?.abort(); state.jobs = state.jobs.filter(j => j !== job); renderGallery(); renderGen(); toast('Cancelled', 'xmark'); } break;
        case 'retry': if (job) { runJob(job); renderGallery(); renderGen(); } break;
        case 'dismiss': if (job) { state.jobs = state.jobs.filter(j => j !== job); renderGallery(); } break;
        case 'sel-clear': state.selected.clear(); armedDel = false; renderGallery(); break;
        case 'sel-ref':
            state.images.filter(i => state.selected.has(i.id)).forEach(refFromImage);
            toast(`Added ${state.selected.size} references`, 'images'); state.selected.clear(); renderGallery(); $('#send_textarea').focus(); break;
        case 'sel-del':
            if (!armedDel) { armedDel = true; renderGallery(); break; }
            { const ids = [...state.selected]; armedDel = false; deleteImages(ids); renderAll(); toast(`Deleted ${ids.length} image${ids.length > 1 ? 's' : ''}`, 'trash-can'); }
            break;
        case 'cur-step': step(+el.dataset.d); break;
        case 'zoom-close': closeViewer(); break;
        case 'zoom-scrim': if (e.target === el) closeViewer(); break;
        case 'copy':
            try { navigator.clipboard.writeText(cur.prompt).then(() => toast('Prompt copied', 'copy'), () => selectPrompt()); } catch { selectPrompt(); }
            break;
        case 'reuse':
            $('#send_textarea').value = cur.prompt; state.provider = cur.provider; state.ratio = cur.ratio;
            if (findModel(cur.provider, cur.model)) state.model = cur.model;
            if (cur.options) state.opts[cur.model] = { ...cur.options };
            savePrefs(); closeViewer(); renderGen(); autosize(); $('#send_textarea').focus(); toast('Prompt, model and size loaded', 'rotate-left'); break;
        case 'cur-ref': refFromImage(cur); closeViewer(); toast('Added as a reference. Describe the change you want.', 'images'); $('#send_textarea').focus(); break;
        case 'cur-del':
            if (!curArmed) { curArmed = true; renderViewer(); break; }
            {
                const list = done(); const idx = list.findIndex(i => i.id === cur.id); const next = list[idx + 1] || list[idx - 1];
                deleteImages([cur.id]); state.current = next ? next.id : null; if (!next) state.zoom = false; curArmed = false; renderAll(); toast('Deleted', 'trash-can');
            }
            break;
        case 'peek': { const inp = $('#keyInput'); inp.type = inp.type === 'password' ? 'text' : 'password'; break; }
        case 'key-save': { const v = $('#keyInput').value.trim(); if (!v) { $('#keyInput').focus(); break; } saveKey(state.provSub, v); break; }
        case 'key-remove': saveKey(state.provSub, ''); break;
        case 'refresh-models': loadModels(state.provSub, true); break;
        case 'toggle-model': {
            // Update the row in place so the list keeps its scroll position and filter.
            toggleEnabled(el.dataset.p, el.dataset.m);
            const pid = el.dataset.p;
            document.querySelectorAll('#modalHost .list-row[data-act="toggle-model"]').forEach(row => {
                row.setAttribute('aria-checked', String(isEnabled(pid, row.dataset.m)));
                const inUse = state.provider === pid && state.model === row.dataset.m;
                const chip = row.querySelector('.in-use');
                if (inUse && !chip) row.querySelector('.t').insertAdjacentHTML('afterend', '<span class="in-use">In use</span>');
                if (!inUse && chip) chip.remove();
            });
            const count = $('#enabledCount');
            if (count) count.textContent = `${enabledIds(pid).length} of ${modelsOf(pid).length} in Generate`;
            break;
        }
        case 'models-clear': {
            for (const id of enabledIds(state.provSub)) toggleEnabled(state.provSub, id);
            renderProviders();
            break;
        }
    }
});
document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'modelSel') { const [p, ...rest] = t.value.split('|'); state.provider = p; state.model = rest.join('|'); savePrefs(); renderGen(); }
    if (t.id === 'fileInput') { addFiles(t.files); t.value = ''; }
    if (t.id === 'moveSel' && t.value) { moveTo([...state.selected], t.value); state.selected.clear(); renderGallery(); }
    if (t.id === 'curCol') { moveTo([state.current], t.value); renderGallery(); }
});
function autosize() { const t = $('#send_textarea'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px'; }
$('#send_textarea').addEventListener('input', autosize);
// Filtering the Providers model list hides rows in place (no re-render, so typing stays smooth).
document.addEventListener('input', e => {
    if (e.target.id !== 'modelFilter') return;
    state.modelFilter = e.target.value;
    const q = state.modelFilter.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll('#modalHost .list-row[data-search]').forEach(row => {
        row.hidden = !!q && !row.dataset.search.includes(q);
        if (!row.hidden) shown++;
    });
    const empty = $('#filterEmpty');
    if (empty) empty.hidden = shown > 0;
});
$('#send_form').addEventListener('submit', e => { e.preventDefault(); generate(); });
$('#send_textarea').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); generate(); } });
$('#send_textarea').addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
});
document.addEventListener('keydown', e => {
    const t = e.target;
    if (t.id === 'renameInput') { if (e.key === 'Enter') renameCol(); if (e.key === 'Escape') { renamingView = false; renderGallery(); } return; }
    if (t.id === 'newColName') { if (e.key === 'Enter') createCol(); if (e.key === 'Escape') { newColOpen = false; renderGallery(); } return; }
    if (t.id === 'keyInput' && e.key === 'Enter') { document.querySelector('[data-act="key-save"]').click(); return; }
    if (e.key === 'Escape') {
        if (state.provOpen) { state.provOpen = false; renderProviders(); }
        else if (state.zoom) closeViewer();
        else if (state.selected.size) { state.selected.clear(); renderGallery(); }
    }
    if (state.zoom && !state.provOpen && !typing() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) step(e.key === 'ArrowLeft' ? -1 : 1);
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#send_textarea').focus(); }
});

/* Drag cards onto collection names (move) or onto the dock (reference); drop files on the dock */
let dragIds = [];
const dropZone = el => el && el.closest && el.closest('#dock');
document.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('.sq[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    dragIds = state.selected.has(id) ? [...state.selected] : [id];
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', dragIds.join(','));
    requestAnimationFrame(() => dragIds.forEach(d => document.querySelector(`.sq[data-id="${d}"]`)?.classList.add('dragging')));
});
document.addEventListener('dragend', () => { dragIds = []; document.querySelectorAll('.dragging, .drop').forEach(n => n.classList.remove('dragging', 'drop')); $('#gen').classList.remove('dragging'); });
document.addEventListener('dragover', e => {
    const pill = e.target.closest && e.target.closest('.room-item[data-drop]');
    const files = e.dataTransfer.types.includes('Files');
    document.querySelectorAll('.room-item.drop').forEach(n => n !== pill && n.classList.remove('drop'));
    if (pill && dragIds.length) { e.preventDefault(); pill.classList.add('drop'); }
    const z = dropZone(e.target);
    $('#gen').classList.toggle('dragging', !!z && (dragIds.length > 0 || files));
    if (z && (dragIds.length || files)) e.preventDefault();
});
document.addEventListener('drop', e => {
    const pill = e.target.closest && e.target.closest('.room-item[data-drop]');
    const z = dropZone(e.target);
    $('#gen').classList.remove('dragging');
    if (pill && dragIds.length) { e.preventDefault(); moveTo(dragIds, pill.dataset.v); state.selected.clear(); renderGallery(); }
    else if (z) {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        else if (dragIds.length) { state.images.filter(i => dragIds.includes(i.id)).forEach(refFromImage); toast(`Added ${dragIds.length} reference${dragIds.length > 1 ? 's' : ''}`, 'images'); }
    }
    dragIds = [];
});
setInterval(() => {
    document.querySelectorAll('[data-elapsed]').forEach(el => { el.textContent = Math.floor((Date.now() - +el.dataset.elapsed) / 1000) + 's'; });
}, 500);

/* ---------- Boot ---------- */
const dockEl = $('#dock');
const setDockH = () => document.documentElement.style.setProperty('--dock-h', dockEl.offsetHeight + 'px');
try { new ResizeObserver(setDockH).observe(dockEl); } catch { addEventListener('resize', setDockH); }
(async () => {
    try {
        const s = await api('GET', '/api/state');
        state.images = s.images; state.collections = s.collections; state.ratios = s.ratios || state.ratios;
        state.enabled = s.settings?.enabledModels || null;
        for (const [id, p] of Object.entries(s.providers)) state.providers[id] = { ...p, models: [], fetching: true };
        if (!state.providers[state.provider]) state.provider = 'google';
        state.provSub = state.provider;
        state.loaded = true;
        renderAll(); setDockH();
        await Promise.all(PROV_ORDER.map(p => loadModels(p)));
        if (!Object.values(state.providers).some(p => p.hasKey)) openProviders('google');
    } catch (err) {
        $('#days').innerHTML = `<div class="empty"><b>Can't reach the server</b>${esc(err.message)}. Start it with <span class="mono">npm start</span> and reload.</div>`;
    }
})();
