// ==UserScript==
// @name         YouTube Lyrics (LRCLIB)
// @namespace    gridmannn
// @author       gridmannn
// @homepageURL  https://github.com/gridmannn/userscripts
// @updateURL    https://raw.githubusercontent.com/gridmannn/userscripts/main/youtube-lyrics.user.js
// @downloadURL  https://raw.githubusercontent.com/gridmannn/userscripts/main/youtube-lyrics.user.js
// @version      1.0
// @description  Shows synced/plain lyrics for the current YouTube / YouTube Music video in a floating panel (lyrics from lrclib.net)
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      lrclib.net
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  let enabled = GM_getValue('enabled', true);
  GM_registerMenuCommand(`${enabled ? 'Disable' : 'Enable'} YouTube Lyrics`, () => {
    GM_setValue('enabled', !enabled);
    location.reload();
  });
  if (!enabled) return;

  const API = 'https://lrclib.net/api';
  const UA = 'YouTubeLyricsUserscript/1.0 (https://github.com/gridmannn)';

  // ---------- state ----------
  let lines = [];          // [{t: seconds, text}] for synced, or [{t:null,text}] for plain
  let synced = false;
  let activeIdx = -1;
  let lastVideoId = null;
  let video = null;
  let userScrolledAt = 0;

  // ---------- UI (no innerHTML: YouTube enforces Trusted Types) ----------
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    kids.forEach(k => n.append(k));
    return n;
  };

  const style = el('style', {
    textContent: `
#ytl-btn{position:fixed;right:16px;bottom:16px;z-index:99999;background:#c00;color:#fff;border:none;
  border-radius:50%;width:44px;height:44px;font:bold 18px sans-serif;cursor:pointer;box-shadow:0 2px 8px #0008}
#ytl-panel{position:fixed;right:16px;bottom:70px;z-index:99999;width:360px;height:60vh;display:none;
  flex-direction:column;background:rgba(15,15,15,.95);color:#ddd;border-radius:12px;
  box-shadow:0 4px 20px #000a;font:14px/1.5 Roboto,Arial,sans-serif;overflow:hidden}
#ytl-panel.open{display:flex}
#ytl-head{padding:8px 10px;border-bottom:1px solid #333;display:flex;gap:6px}
#ytl-q{flex:1;background:#222;color:#eee;border:1px solid #444;border-radius:6px;padding:4px 8px;font-size:13px}
#ytl-head button{background:#333;color:#eee;border:none;border-radius:6px;padding:4px 8px;cursor:pointer}
#ytl-status{padding:4px 12px;font-size:12px;color:#888}
#ytl-body{flex:1;overflow-y:auto;padding:8px 14px 40vh}
.ytl-line{padding:3px 0;white-space:pre-wrap;transition:color .2s,font-size .2s}
.ytl-line.sync{cursor:pointer;color:#777}
.ytl-line.sync:hover{color:#bbb}
.ytl-line.active{color:#fff;font-weight:bold;font-size:16px}
.ytl-res{padding:6px;border-bottom:1px solid #2a2a2a;cursor:pointer}
.ytl-res:hover{background:#222}`
  });

  const btn = el('button', { id: 'ytl-btn', title: 'Lyrics (Alt+L)', textContent: '♪' });
  const q = el('input', { id: 'ytl-q', placeholder: 'Artist - Title' });
  const searchBtn = el('button', { textContent: 'Search' });
  const status = el('div', { id: 'ytl-status' });
  const body = el('div', { id: 'ytl-body' });
  const panel = el('div', { id: 'ytl-panel' }, el('div', { id: 'ytl-head' }, q, searchBtn), status, body);

  document.head.append(style);
  document.body.append(btn, panel);

  const setOpen = open => {
    panel.classList.toggle('open', open);
    GM_setValue('open', open);
    if (open && !lines.length) autoLoad(true);
  };
  btn.onclick = () => setOpen(!panel.classList.contains('open'));
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key.toLowerCase() === 'l') { e.preventDefault(); setOpen(!panel.classList.contains('open')); }
  });
  searchBtn.onclick = () => manualSearch(q.value.trim());
  q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') manualSearch(q.value.trim()); });
  body.addEventListener('wheel', () => (userScrolledAt = Date.now()), { passive: true });

  // ---------- helpers ----------
  const req = url => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url, headers: { 'Lrclib-Client': UA, Accept: 'application/json' },
      onload: r => (r.status === 200 ? resolve(JSON.parse(r.responseText)) : reject(r.status)),
      onerror: reject, ontimeout: reject, timeout: 15000
    });
  });

  const clean = s => s
    .replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali[sz]er|hd|hq|4k|remaster|live|mv|m\/v)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
    .replace(/["“”]/g, '')
    .trim();

  function getMeta() {
    const isMusic = location.hostname === 'music.youtube.com';
    let title, channel;
    if (isMusic) {
      title = document.querySelector('ytmusic-player-bar .title')?.textContent;
      channel = document.querySelector('ytmusic-player-bar .byline a')?.textContent;
    } else {
      title = document.querySelector('ytd-watch-metadata h1')?.textContent
           || document.title.replace(/ - YouTube$/, '');
      channel = document.querySelector('ytd-watch-metadata ytd-channel-name a')?.textContent;
    }
    title = (title || '').trim(); channel = (channel || '').trim().replace(/\s*-\s*Topic$/, '').replace(/VEVO$/i, '');
    let artist = channel, track = title;
    const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) { artist = m[1]; track = m[2]; }
    return { artist: clean(artist), track: clean(track), duration: video?.duration || 0 };
  }

  function parseLRC(lrc) {
    const out = [];
    for (const raw of lrc.split('\n')) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const s of stamps) out.push({ t: +s[1] * 60 + +s[2], text: text || '♪' });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function pickBest(results, duration) {
    if (!results?.length) return null;
    const score = r => {
      let s = duration && r.duration ? Math.abs(r.duration - duration) : 30;
      if (!r.syncedLyrics) s += 15;
      if (r.instrumental) s += 100;
      return s;
    };
    return [...results].sort((a, b) => score(a) - score(b))[0];
  }

  // ---------- render ----------
  function show(rec) {
    body.replaceChildren(); activeIdx = -1;
    if (!rec) { lines = []; status.textContent = 'No lyrics found. Try editing the search.'; return; }
    if (rec.instrumental) { lines = []; status.textContent = 'Instrumental'; return; }
    synced = !!rec.syncedLyrics;
    lines = synced ? parseLRC(rec.syncedLyrics)
                   : (rec.plainLyrics || '').split('\n').map(text => ({ t: null, text }));
    status.textContent = `${rec.artistName} – ${rec.trackName}${synced ? ' • synced' : ' • plain'}`;
    lines.forEach((l, i) => {
      const d = el('div', { className: 'ytl-line' + (synced ? ' sync' : ''), textContent: l.text });
      if (synced) d.onclick = () => { if (video) video.currentTime = l.t; };
      l.node = d; body.append(d);
    });
    body.scrollTop = 0;
  }

  function showResults(results) {
    body.replaceChildren(); lines = [];
    if (!results.length) { status.textContent = 'No results.'; return; }
    status.textContent = `${results.length} results – click one`;
    results.slice(0, 20).forEach(r => {
      const mm = Math.floor(r.duration / 60), ss = String(Math.round(r.duration % 60)).padStart(2, '0');
      body.append(el('div', {
        className: 'ytl-res',
        textContent: `${r.artistName} – ${r.trackName} (${mm}:${ss})${r.syncedLyrics ? ' ⏱' : ''}`,
        onclick: () => show(r)
      }));
    });
  }

  // ---------- loading ----------
  async function autoLoad(force = false) {
    const vid = new URLSearchParams(location.search).get('v');
    if (!vid || (!force && vid === lastVideoId)) return;
    lastVideoId = vid;
    lines = []; body.replaceChildren();
    if (!panel.classList.contains('open')) return; // lazy: fetch only when panel is open
    await new Promise(r => setTimeout(r, 1200)); // let YouTube update title/channel
    const m = getMeta();
    q.value = m.artist ? `${m.artist} - ${m.track}` : m.track;
    status.textContent = 'Searching…';
    try {
      let rec = null;
      if (m.artist) {
        const p = new URLSearchParams({ track_name: m.track, artist_name: m.artist });
        rec = pickBest(await req(`${API}/search?${p}`), m.duration);
      }
      if (!rec) rec = pickBest(await req(`${API}/search?q=${encodeURIComponent(`${m.artist} ${m.track}`.trim())}`), m.duration);
      show(rec);
    } catch (e) { status.textContent = 'Lookup failed (' + e + ')'; }
  }

  async function manualSearch(term) {
    if (!term) return;
    status.textContent = 'Searching…';
    try { showResults(await req(`${API}/search?q=${encodeURIComponent(term.replace(/\s+-\s+/, ' '))}`)); }
    catch (e) { status.textContent = 'Search failed (' + e + ')'; }
  }

  // ---------- sync ----------
  function tick() {
    if (!synced || !lines.length || !video || !panel.classList.contains('open')) return;
    const t = video.currentTime + 0.25;
    let i = lines.length - 1;
    while (i >= 0 && lines[i].t > t) i--;
    if (i === activeIdx) return;
    lines[activeIdx]?.node.classList.remove('active');
    activeIdx = i;
    const n = lines[i]?.node;
    if (n) {
      n.classList.add('active');
      if (Date.now() - userScrolledAt > 4000)
        body.scrollTo({ top: n.offsetTop - body.clientHeight / 3, behavior: 'smooth' });
    }
  }

  function hookVideo() {
    const v = document.querySelector('video');
    if (v && v !== video) { video = v; video.addEventListener('timeupdate', tick); }
  }

  // ---------- SPA navigation ----------
  const onNav = () => { hookVideo(); autoLoad(); };
  window.addEventListener('yt-navigate-finish', onNav);           // youtube.com
  setInterval(() => {                                              // fallback + music.youtube.com
    hookVideo();
    const vid = new URLSearchParams(location.search).get('v');
    if (vid && vid !== lastVideoId) autoLoad();
  }, 1500);

  if (GM_getValue('open', false)) setOpen(true);
  onNav();
})();
