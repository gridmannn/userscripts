// ==UserScript==
// @name         Endless STL Pages
// @namespace    gridmannn
// @author       gridmannn
// @homepageURL  https://github.com/gridmannn/userscripts
// @updateURL    https://raw.githubusercontent.com/gridmannn/userscripts/main/endless-stl-pages.user.js
// @downloadURL  https://raw.githubusercontent.com/gridmannn/userscripts/main/endless-stl-pages.user.js
// @version      1.2
// @description  Endless-Google-style auto paging for Thingiverse, Printables, MakerWorld, Cults3D, MyMiniFactory, Thangs
// @match        https://www.thingiverse.com/*
// @match        https://thingiverse.com/*
// @match        https://www.printables.com/*
// @match        https://makerworld.com/*
// @match        https://cults3d.com/*
// @match        https://www.myminifactory.com/*
// @match        https://thangs.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Per-site: regex that identifies a link to a model page, and the page query param
  const SITES = {
    'thingiverse.com':   { item: /\/thing:\d+/,          param: 'page' },
    'printables.com':    { item: /\/model\/\d+/,         param: 'page' },
    'makerworld.com':    { item: /\/models\/\d+/,        param: 'page' },
    'cults3d.com':       { item: /\/3d-model\//,         param: 'page' },
    'myminifactory.com': { item: /\/object\//,           param: 'page' },
    'thangs.com':        { item: /\/3d-model\//,         param: 'page' },
  };
  const host = Object.keys(SITES).find(h => location.hostname.endsWith(h));
  if (!host) return;
  const SITE = SITES[host];

  const TRIGGER_PX = () => Math.max(2500, innerHeight * 3); // start loading when this close to bottom
  const IFRAME_TIMEOUT = 15000; // ms to wait for JS-rendered pages

  let enabled = GM_getValue('enabled', true);
  GM_registerMenuCommand((enabled ? 'Disable' : 'Enable') + ' endless pages', () => {
    GM_setValue('enabled', !enabled); location.reload();
  });
  if (!enabled) return;

  // ---------- state ----------
  let state;
  function reset() {
    state = { url: location.href, page: currentPage(), nextUrl: null, lastDoc: document,
              loading: false, done: false, pending: null, seen: new Set() };
    itemLinks(document).forEach(a => state.seen.add(norm(a.href)));
  }

  function currentPage() {
    const p = parseInt(new URL(location.href).searchParams.get(SITE.param), 10);
    return isNaN(p) ? 1 : p;
  }
  const norm = h => { try { const u = new URL(h, location.href); return u.origin + u.pathname; } catch { return h; } };
  const itemLinks = doc => [...doc.querySelectorAll('a[href]')].filter(a => SITE.item.test(a.getAttribute('href')));

  // Find the container holding the most model cards; return {grid, items}
  function findGrid(doc) {
    const counts = new Map();
    for (const a of itemLinks(doc)) {
      let child = a, p = a.parentElement;
      while (p && p !== doc.body) {
        if (!counts.has(p)) counts.set(p, new Set());
        counts.get(p).add(child);
        child = p; p = p.parentElement;
      }
    }
    let best = null, bestN = 2;
    for (const [p, kids] of counts) {
      if (kids.size > bestN || (kids.size === bestN && best && best.contains(p))) { best = p; bestN = kids.size; }
    }
    return best ? { grid: best, items: [...counts.get(best)] } : null;
  }

  // ---------- next-page detection ----------
  function findNextUrl(doc, baseUrl) {
    const rel = doc.querySelector('link[rel="next"], a[rel="next"]');
    if (rel && rel.getAttribute('href')) return new URL(rel.getAttribute('href'), baseUrl).href;
    const a = [...doc.querySelectorAll('a[href]')].find(el =>
      /next/i.test(el.getAttribute('aria-label') || '') || /^\s*(next|›|»|>)\s*$/i.test(el.textContent));
    if (a) return new URL(a.getAttribute('href'), baseUrl).href;
    const u = new URL(baseUrl);
    u.searchParams.set(SITE.param, String(state.page + 1));
    return u.href;
  }

  function findLoadMore() {
    return [...document.querySelectorAll('button, a')].find(el =>
      el.offsetParent !== null && !el.disabled &&
      /^\s*(load|show|view)\s+more|more\s+results/i.test(el.textContent));
  }

  // ---------- loading ----------
  async function fetchDoc(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(r.status);
    return new DOMParser().parseFromString(await r.text(), 'text/html');
  }

  // For JS-rendered sites: load the page in a hidden same-origin iframe and wait for cards
  function iframeDoc(url) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1400px;height:3000px;visibility:hidden;';
      f.src = url;
      const t0 = Date.now(); let last = -1, stable = 0;
      const timer = setInterval(() => {
        let d; try { d = f.contentDocument; } catch { d = null; }
        const n = d ? itemLinks(d).length : 0;
        if (d) try { f.contentWindow.scrollTo(0, d.body.scrollHeight); } catch {}
        stable = (n > 0 && n === last) ? stable + 1 : 0; last = n;
        if (stable >= 3 || Date.now() - t0 > IFRAME_TIMEOUT) {
          clearInterval(timer);
          if (n > 0) resolve({ doc: d, cleanup: () => f.remove() });
          else { f.remove(); reject(new Error('no items')); }
        }
      }, 500);
      document.body.appendChild(f);
    });
  }

  function fixImages(node) {
    node.querySelectorAll('img').forEach(img => {
      const ds = img.dataset.src || img.dataset.lazySrc || img.dataset.original;
      if (ds) img.src = ds;
      if (img.dataset.srcset) img.srcset = img.dataset.srcset;
      img.loading = 'eager';
    });
    node.querySelectorAll('source[data-srcset]').forEach(s => (s.srcset = s.dataset.srcset));
  }

  function separator(n, url) {
    const d = document.createElement('div');
    d.style.cssText = 'grid-column:1/-1;flex-basis:100%;width:100%;text-align:center;padding:12px;margin:8px 0;' +
      'font:bold 14px sans-serif;color:#888;border-top:2px dashed #888;';
    d.innerHTML = `— Page ${n} — <a href="${url}" style="color:inherit">open</a>`;
    return d;
  }

  function status(msg) {
    let s = document.getElementById('esp-status');
    if (!s) {
      s = document.createElement('div'); s.id = 'esp-status';
      s.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;background:#222;color:#fff;' +
        'padding:6px 10px;border-radius:6px;font:12px sans-serif;opacity:.85;';
      document.body.appendChild(s);
    }
    s.textContent = msg; s.style.display = msg ? 'block' : 'none';
  }

  const log = (...a) => console.log('[EndlessSTL]', ...a);

  // Fetch a page (plain fetch first, hidden iframe for JS-rendered sites)
  async function getPage(url) {
    let doc, cleanup = () => {};
    try {
      doc = await fetchDoc(url);
      if (!findGrid(doc)) ({ doc, cleanup } = await iframeDoc(url));
    } catch (e) {
      log('fetch failed, trying iframe', e.message);
      try { ({ doc, cleanup } = await iframeDoc(url)); } catch (e2) { log('iframe failed', e2.message); doc = null; }
    }
    return { doc, cleanup, url };
  }

  // Start loading the next page in the background so it's ready before you reach the bottom
  function prefetch() {
    if (state.pending || state.done) return;
    const url = state.nextUrl || findNextUrl(state.lastDoc, location.href);
    log('prefetching', url);
    state.pending = getPage(url);
  }

  async function loadNext() {
    if (state.loading || state.done) return;

    const btn = findLoadMore();                    // site's own "Load more" button
    if (btn) { log('clicking', btn.textContent.trim()); btn.click(); return; }

    const live = findGrid(document);
    if (!live) { log('no model grid found'); return; }
    state.loading = true;
    prefetch();
    status(`Loading page ${state.page + 1}…`);

    const { doc, cleanup, url } = await state.pending;
    state.pending = null;

    const src = doc && findGrid(doc);
    const fresh = src ? src.items.filter(el => {
      const links = itemLinks(el).map(a => norm(a.href));
      return links.length && !links.some(h => state.seen.has(h));
    }) : [];

    log('page', state.page + 1, ':', src ? src.items.length : 0, 'cards,', fresh.length, 'new');
    if (!fresh.length) {
      state.done = true; status('No more pages'); setTimeout(() => status(''), 3000);
      cleanup(); state.loading = false; return;
    }

    state.page++;
    live.grid.appendChild(separator(state.page, url));
    for (const el of fresh) {
      itemLinks(el).forEach(a => state.seen.add(norm(a.href)));
      const c = document.importNode(el, true);
      fixImages(c);
      live.grid.appendChild(c);
    }
    state.lastDoc = doc;
    state.nextUrl = (() => { const n = findNextUrl(doc, url); return n === url ? null : n; })();
    cleanup();
    status('');
    state.loading = false;
    prefetch();                 // get the following page ready now
    setTimeout(check, 200);     // keep going if still near the bottom
  }

  // ---------- triggers ----------
  function check() {
    if (location.href !== state.url && !location.href.includes('#')) reset(); // SPA navigation
    const g = findGrid(document);
    const nearBottom = g ? g.grid.getBoundingClientRect().bottom - innerHeight < TRIGGER_PX()
                         : document.documentElement.scrollHeight - (window.scrollY + innerHeight) < TRIGGER_PX();
    if (nearBottom) loadNext();
  }

  reset();
  log('running on', location.href);
  status('Endless STL Pages active'); setTimeout(() => status(''), 2500);
  document.addEventListener('scroll', check, { passive: true, capture: true });
  window.addEventListener('wheel', check, { passive: true });
  window.addEventListener('keydown', check, { passive: true });
  setInterval(check, 1000);
  setTimeout(() => { if (findGrid(document)) prefetch(); }, 1500);  // preload page 2 right away
})();
