// ==UserScript==
// @name         Anti-Adblock Remover (playmate.to / watchmmafull.com)
// @namespace    gridmannn.scripts
// @author       gridmannn
// @version      1.0.1
// @description  Removes adblock-detection overlays/popups so the page behaves as if no ad blocker was detected
// @homepageURL  https://github.com/gridmannn/userscripts
// @updateURL    https://raw.githubusercontent.com/gridmannn/userscripts/main/anti-adblock-remover.user.js
// @downloadURL  https://raw.githubusercontent.com/gridmannn/userscripts/main/anti-adblock-remover.user.js
// @match        https://playmate.to/embed*
// @match        https://*.playmate.to/embed*
// @match        https://watchmmafull.com/*
// @match        https://*.watchmmafull.com/*
// @match        https://jamesbornmain.com/*
// @match        https://*.jamesbornmain.com/*
// @match        https://voe.sx/*
// @match        https://*.voe.sx/*
// @match        *://*/e/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Common selectors used by anti-adblock scripts (overlays, modals, blur layers)
    const KILL_SELECTORS = [
        '[id*="adblock" i]',
        '[class*="adblock" i]',
        '[id*="ad-block" i]',
        '[class*="ad-block" i]',
        '[id*="anti-ad" i]',
        '[class*="anti-ad" i]',
        '[class*="detector" i]',
        '[id*="detector" i]',
        '[class*="overlay-ad" i]',
        '.ads', '.ad-container', '.ad-banner', '.adsbox', '.ad-placement',
        '[class*="please-disable" i]',
        '[id*="please-disable" i]'
    ];

    // Neutralize the most common anti-adblock JS libraries before their code runs.
    // These libraries check `typeof window.FuckAdBlock === 'undefined'` etc. to decide
    // whether a blocker is present, so pre-defining them as "always found, always clean"
    // objects short-circuits that check.
    const stubLib = () => {
        function Stub() {}
        Stub.prototype.check = () => false;
        Stub.prototype.onDetected = function () { return this; };
        Stub.prototype.onNotDetected = function (cb) { if (typeof cb === 'function') cb(); return this; };
        Stub.prototype.setOption = function () { return this; };
        return Stub;
    };
    ['FuckAdBlock', 'BlockAdBlock', 'blockAdBlock', 'sniffAdBlock', 'adblockDetector'].forEach(name => {
        try {
            Object.defineProperty(window, name, {
                configurable: true,
                get: () => stubLib(),
                set: () => {}
            });
        } catch (e) { /* ignore */ }
    });

    // --- Pre-emptive defeats for detection that runs BEFORE any overlay/block page
    // gets built (e.g. VOE's "Ad blockers are not allowed" full-page swap). These
    // must be in place before the site's own check code executes, hence document-start.

    // 1) Bait-element trick: many detectors create a div named like "ad"/"ads"/"banner",
    // insert it, then check its rendered size — an ad blocker's CSS hides it (0 height).
    // Force any such element to report a non-zero size so the check thinks it rendered.
    const AD_BAIT_RE = /\b(ad|ads|advert|banner|sponsor)\b/i;
    ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'].forEach(prop => {
        const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop) ||
                     Object.getOwnPropertyDescriptor(Element.prototype, prop);
        if (!desc || !desc.get) return;
        const origGet = desc.get;
        Object.defineProperty(HTMLElement.prototype, prop, {
            configurable: true,
            get: function () {
                const real = origGet.call(this);
                if (real === 0) {
                    const tag = (this.className && this.className.toString()) + ' ' + (this.id || '');
                    if (AD_BAIT_RE.test(tag)) return 1;
                }
                return real;
            }
        });
    });

    // 2) Network-probe trick: detectors load a script/pixel from a known ad host and
    // treat a failed/blocked request as proof of an ad blocker. Make those requests
    // look like they succeeded.
    const AD_HOST_RE = /doubleclick\.net|googlesyndication|google-analytics|adservice\.google|amazon-adsystem|adsafeprotected|pagead2|\/ads?[./]|adnxs\.com/i;
    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (AD_HOST_RE.test(url)) {
                return Promise.resolve(new Response('', { status: 200 }));
            }
            return origFetch.call(this, input, init);
        };
    }
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
        window.XMLHttpRequest = function () {
            const xhr = new OrigXHR();
            const origOpen = xhr.open;
            xhr.open = function (method, url, ...rest) {
                if (AD_HOST_RE.test(url)) {
                    this._fakeAd = true;
                }
                return origOpen.call(this, method, url, ...rest);
            };
            return xhr;
        };
    }

    // --- JW Player specific fix ---
    // This site's block screen is driven by JW Player's own built-in ad-block
    // detection (jwplayer.js / jwplayer.core.controls.js), which fires an
    // internal "adBlock" event that the page listens for. Intercept window.jwplayer
    // itself so every player instance it creates has that event permanently muted,
    // and getAdBlock() always reports "no blocker found".
    (function patchJWPlayer() {
        let realFactory = window.jwplayer;

        function neutralize(instance) {
            if (!instance || instance.__adblockPatched) return instance;
            instance.__adblockPatched = true;
            ['on', 'once'].forEach(method => {
                const orig = instance[method];
                if (typeof orig === 'function') {
                    instance[method] = function (name, ...rest) {
                        if (name === 'adBlock') return instance; // drop the subscription
                        return orig.call(this, name, ...rest);
                    };
                }
            });
            const origTrigger = instance.trigger;
            if (typeof origTrigger === 'function') {
                instance.trigger = function (name, ...args) {
                    if (name === 'adBlock') return instance; // never actually fire it
                    return origTrigger.call(this, name, ...args);
                };
            }
            if (typeof instance.getAdBlock === 'function') {
                instance.getAdBlock = () => false;
            }
            return instance;
        }

        Object.defineProperty(window, 'jwplayer', {
            configurable: true,
            get() { return realFactory; },
            set(fn) {
                if (typeof fn !== 'function') { realFactory = fn; return; }
                const wrapped = function (...args) {
                    return neutralize(fn.apply(this, args));
                };
                Object.keys(fn).forEach(k => { try { wrapped[k] = fn[k]; } catch (e) {} });
                if (fn.prototype) wrapped.prototype = fn.prototype;
                realFactory = wrapped;
            }
        });
    })();

    function unlockScroll() {
        if (!document.body) return; // body doesn't exist yet at document-start
        document.documentElement.style.overflow = 'auto';
        document.body.style.overflow = 'auto';
        document.documentElement.style.position = 'static';
        document.body.style.position = 'static';
    }

    function purge() {
        KILL_SELECTORS.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => el.remove());
        });
        unlockScroll();
    }

    // Neutralize common detection tricks: bait elements, function name checks, and
    // frame-busting timers that anti-adblock scripts poll.
    const origSetTimeout = window.setTimeout;
    window.setTimeout = function (fn, delay, ...args) {
        try {
            const src = fn && fn.toString ? fn.toString() : '';
            if (/adblock|blockAdBlock|detectAdBlock/i.test(src)) {
                return origSetTimeout(() => {}, delay);
            }
        } catch (e) { /* ignore */ }
        return origSetTimeout(fn, delay, ...args);
    };

    // Run continuously since these overlays are often re-injected
    new MutationObserver(purge).observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    document.addEventListener('DOMContentLoaded', purge);
    origSetTimeout(purge, 500);
    origSetTimeout(purge, 1500);
    origSetTimeout(purge, 3000);
})();
