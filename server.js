/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          3DS MEGA PROXY  –  server.js  (v3.0)                   ║
 * ║  Drop-in for Nintendo 3DS browser  –  Node.js 18+               ║
 * ║                                                                  ║
 * ║  npm install express axios cheerio css iconv-lite               ║
 * ║              node-html-parser entities                           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * FEATURES:
 *  • DuckDuckGo Lite primary search (no JS, 3DS-friendly)
 *  • Reader / article mode  (/reader?url=…)
 *  • Image search results  (/images?q=…)
 *  • Wikipedia quick-look  (/wiki?q=…)
 *  • Translation via LibreTranslate  (/translate?url=…&lang=…)
 *  • In-proxy bookmarks (stored server-side per-session cookie)
 *  • Browsing history  (/history)
 *  • RSS / Atom reader  (/rss?url=…)
 *  • Weather widget  (/weather?q=…)
 *  • Page simplifier – strips heavy layout, keeps text + links
 *  • File/download helper – shows file info before download
 *  • YouTube / Vimeo / Dailymotion → lightweight embed shim
 *  • Twitter/X → nitter redirect
 *  • Reddit → old.reddit redirect
 *  • Cookie jar forwarding (sites that require login sessions)
 *  • Cache layer (5-min in-memory) to speed up repeat visits
 *  • Aggressive JS polyfill shim for 3DS WebKit
 *  • Modern CSS → legacy CSS transforms (flex→table, grid→block, etc.)
 *  • All JS const/let → var, arrow fns → function, template literals → concat
 *  • Removes SVG sprite, Web Components, Shadow DOM references
 *  • srcset / picture → single <img> fallback
 *  • Strips CORS / CSP / HSTS headers
 *  • Handles gzip / deflate / brotli decompression
 *  • Proxies iframes, CSS @imports, JS fetch() calls
 *  • Smart URL / search detection on home page
 *  • Clean 3DS-sized UI (400px wide) on every page
 */

'use strict';

const express      = require('express');
const axios        = require('axios');
const cheerio      = require('cheerio');
const css          = require('css');
const urlModule    = require('url');
const iconv        = require('iconv-lite');
const http         = require('http');
const crypto       = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const LIBRETRANSLATE_URL = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com';
const LIBRETRANSLATE_KEY = process.env.LIBRETRANSLATE_KEY || '';   // set env var if you have a key

// ─── IN-MEMORY CACHE (5 min TTL) ────────────────────────────────────────────

const PAGE_CACHE   = new Map();   // url → { ts, data, ct }
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(url) {
  const e = PAGE_CACHE.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { PAGE_CACHE.delete(url); return null; }
  return e;
}
function cacheSet(url, data, ct) {
  if (PAGE_CACHE.size > 200) {
    // evict oldest 50 entries
    const keys = [...PAGE_CACHE.keys()].slice(0, 50);
    keys.forEach(k => PAGE_CACHE.delete(k));
  }
  PAGE_CACHE.set(url, { ts: Date.now(), data, ct });
}

// ─── SERVER-SIDE BOOKMARKS & HISTORY (keyed by session cookie) ──────────────

const SESSIONS  = new Map();   // sid → { bookmarks:[], history:[] }
const MAX_HIST  = 50;
const MAX_BOOK  = 100;

function getSession(req, res) {
  let sid = req.cookies && req.cookies.__3ds_sid;
  if (!sid || !SESSIONS.has(sid)) {
    sid = crypto.randomBytes(12).toString('hex');
    SESSIONS.set(sid, { bookmarks: [], history: [] });
    res.cookie('__3ds_sid', sid, { maxAge: 60 * 60 * 24 * 30, httpOnly: true });
  }
  return SESSIONS.get(sid);
}

// tiny cookie parser (avoid adding another dep)
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// ─── COOKIE JAR (site cookies forwarded through proxy) ───────────────────────

const COOKIE_JAR = new Map();   // host → cookie string

function cookiesFor(host) { return COOKIE_JAR.get(host) || ''; }
function storeCookies(host, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const existing = {};
  (COOKIE_JAR.get(host) || '').split(';').forEach(p => {
    const [k, v] = p.trim().split('=');
    if (k) existing[k.trim()] = v || '';
  });
  headers.forEach(h => {
    const part = h.split(';')[0].trim();
    const [k, v] = part.split('=');
    if (k) existing[k.trim()] = v || '';
  });
  COOKIE_JAR.set(host, Object.entries(existing).map(([k,v]) => `${k}=${v}`).join('; '));
}

// ─── URL HELPERS ─────────────────────────────────────────────────────────────

function resolveUrl(base, relative) {
  try {
    if (!relative) return base;
    if (relative.startsWith('data:') || relative.startsWith('javascript:')) return relative;
    if (relative.startsWith('//')) {
      const b = new urlModule.URL(base);
      return `${b.protocol}${relative}`;
    }
    return new urlModule.URL(relative, base).href;
  } catch { return relative; }
}

function proxyUrl(abs, proxyBase) {
  return `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`;
}

function htmlEsc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── SITE REWRITES ───────────────────────────────────────────────────────────

function rewriteTargetUrl(url) {
  try {
    const u = new urlModule.URL(url);
    const h = u.hostname.replace(/^www\./, '');

    // Reddit → old.reddit
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) {
      return url.replace(/https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
    }
    // Twitter / X → nitter
    if (h === 'twitter.com' || h === 'x.com') {
      return url.replace(/https?:\/\/(www\.)?(twitter|x)\.com/, 'https://nitter.net');
    }
    // Medium → scribe
    if (h === 'medium.com' || h.endsWith('.medium.com')) {
      return url.replace(/https?:\/\/([^/]*\.)?medium\.com/, 'https://scribe.rip');
    }
    // YouTube → use our embed shim
    if (h === 'youtube.com' || h === 'youtu.be') {
      return url; // handled in transformHTML
    }
  } catch {}
  return url;
}

// ─── AXIOS HELPER ────────────────────────────────────────────────────────────

async function proxyFetch(targetUrl, options = {}) {
  let host = '';
  try { host = new urlModule.URL(targetUrl).hostname; } catch {}

  return await axios({
    url: targetUrl,
    method: options.method || 'GET',
    headers: {
      'User-Agent'      : MODERN_UA,
      'Accept'          : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language' : 'en-US,en;q=0.9',
      'Accept-Encoding' : 'gzip, deflate, br',
      'Cookie'          : cookiesFor(host),
      ...(options.headers || {})
    },
    data: options.data,
    params: options.params,
    responseType: 'arraybuffer',
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 20000,
    decompress: true
  });
}

// ─── CSS TRANSFORM ───────────────────────────────────────────────────────────

function transformCSS(rawCss, baseUrl, proxyBase) {
  // Proxy url() references
  rawCss = rawCss.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('#')) return m;
    const abs = resolveUrl(baseUrl, u);
    return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
  });

  // Proxy @import
  rawCss = rawCss.replace(/@import\s+['"]([^'"]+)['"]/g, (m, u) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(baseUrl, u);
    return `@import '${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}'`;
  });
  rawCss = rawCss.replace(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, u) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(baseUrl, u);
    return `@import url('${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}')`;
  });

  // Modern CSS → legacy replacements
  rawCss = rawCss
    // Remove custom properties (--var: value) declarations – 3DS can't use them
    .replace(/--[\w-]+\s*:[^;]+;/g, '')
    // Remove :root variable blocks
    .replace(/:root\s*\{[^}]*\}/g, '')
    // Remove calc() – replace with rough literal (just remove calc() wrapper)
    .replace(/calc\(([^)]+)\)/g, (m, inner) => inner.split(/[\+\-\*\/]/)[0].trim() || '0')
    // Remove CSS Grid declarations
    .replace(/display\s*:\s*grid\s*;/g, 'display: block;')
    .replace(/grid-[^:]+:[^;]+;/g, '')
    .replace(/display\s*:\s*inline-grid\s*;/g, 'display: inline-block;')
    // Remove flexbox (convert to block/inline-block)
    .replace(/display\s*:\s*flex\s*;/g, 'display: block;')
    .replace(/display\s*:\s*inline-flex\s*;/g, 'display: inline-block;')
    .replace(/flex(?:-direction|-wrap|-flow|-grow|-shrink|-basis|-align)?[^:]*:[^;]+;/g, '')
    .replace(/align-(?:items|self|content)\s*:[^;]+;/g, '')
    .replace(/justify-(?:content|items|self)\s*:[^;]+;/g, '')
    // Remove transitions and animations (3DS can't GPU-compose them)
    .replace(/transition\s*:[^;]+;/g, '')
    .replace(/animation\s*:[^;]+;/g, '')
    .replace(/@keyframes\s+[\w-]+\s*\{[^}]*\}/g, '')
    // Remove CSS filters
    .replace(/filter\s*:[^;]+;/g, '')
    // Remove backdrop-filter
    .replace(/backdrop-filter\s*:[^;]+;/g, '')
    // Remove clip-path
    .replace(/clip-path\s*:[^;]+;/g, '')
    // Remove pointer-events
    .replace(/pointer-events\s*:[^;]+;/g, '')
    // Remove will-change
    .replace(/will-change\s*:[^;]+;/g, '')
    // Remove CSS variables usage (var(--x))
    .replace(/var\(--[\w-]+(?:,[^)]*)?\)/g, 'inherit')
    // Remove modern media queries (prefers-color-scheme etc.)
    .replace(/@media\s*\([^)]*prefers-[^)]*\)[^{]*\{[^{}]*\}/g, '')
    // Remove @supports blocks
    .replace(/@supports[^{]+\{[\s\S]*?\}\s*\}/g, '');

  try {
    const parsed = css.parse(rawCss, { silent: true });
    return css.stringify(parsed);
  } catch {
    return rawCss;
  }
}

// ─── JS TRANSFORM ────────────────────────────────────────────────────────────

function transformJS(src, proxyBase, baseUrl) {
  if (!src || typeof src !== 'string') return src || '';
  try {
    src = src
      // const/let → var
      .replace(/\b(const|let)\b/g, 'var')

      // Arrow functions → regular functions (simple cases)
      .replace(/\(([^)]*)\)\s*=>\s*\{/g, 'function($1){')
      .replace(/\(([^)]*)\)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')
      .replace(/([\w$]+)\s*=>\s*\{/g, 'function($1){')
      .replace(/([\w$]+)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')

      // Template literals → string concat (basic, non-nested)
      .replace(/`([^`]*)`/g, (m, inner) => {
        const parts = inner.split(/(\$\{[^}]+\})/);
        return parts.map(p => {
          if (p.startsWith('${') && p.endsWith('}')) return p.slice(2, -1);
          return JSON.stringify(p);
        }).join('+');
      })

      // Spread in arrays/objects (partial: remove spread)
      .replace(/\.\.\.([\w$]+)/g, '$1')

      // Destructuring (very basic: var {a,b}=x → var a=x.a,b=x.b)
      // (skip full destructuring – too risky to mangle)

      // Proxy location assignments to go through our proxy
      .replace(/(window\.location\.href\s*=\s*|window\.location\s*=\s*|location\.href\s*=\s*)(['"])(https?:\/\/[^'"]+)(['"])/g,
        (m, pre, q1, u, q2) => `${pre}${q1}${proxyBase}/proxy?url=${encodeURIComponent(u)}${q2}`)

      // Block browser-upgrade redirects
      .replace(/\b(window\.location\s*=\s*['"][^'"]*(?:unsupported|upgrade|outdated|oldbrowser)[^'"]*['"])/gi, '0/*blocked*/')

      // document.write → void (kills old browser DOM)
      .replace(/document\.write\s*\(/g, 'void(0&&(')

      // Remove import/export statements (modules crash old WebKit)
      .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
      .replace(/^\s*export\s+(default\s+)?/gm, '')

      // async/await → no-op (partial: async fn → fn, await expr → expr)
      .replace(/\basync\s+function\b/g, 'function')
      .replace(/\basync\s+\(/g, '(')
      .replace(/\bawait\s+/g, '')

      // class syntax → function (very rough — removes extends, uses prototype)
      .replace(/\bclass\s+([\w$]+)(?:\s+extends\s+[\w$.]+)?\s*\{/g, 'var $1 = function() {')

      // Remove "use strict"
      .replace(/"use strict";?/g, '')
      .replace(/'use strict';?/g, '')

      // Remove nullish coalescing and optional chaining (3DS JS engine won't parse)
      .replace(/\?\./g, '.')
      .replace(/\?\?/g, '||')

      // Logical assignment operators
      .replace(/\|\|=/g, '= arguments[0] ||')
      .replace(/&&=/g, '= arguments[0] &&')
      .replace(/\?\?=/g, '= arguments[0] !=null ? arguments[0] :');

    return src;
  } catch { return src; }
}

// ─── VIDEO EMBED SHIM ────────────────────────────────────────────────────────

function buildVideoShim(proxyBase, embedUrl, title) {
  return `<div style="border:1px solid #aaa;padding:8px;margin:8px 0;background:#ffe;">
<b>Video: ${htmlEsc(title || 'Embedded Video')}</b><br>
<small>Video players are not supported on the 3DS browser.</small><br>
<a href="${proxyBase}/proxy?url=${encodeURIComponent(embedUrl)}">Open video page</a>
</div>`;
}

function youtubeId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ─── READER MODE EXTRACTOR ───────────────────────────────────────────────────

function extractReadableContent($, targetUrl, proxyBase) {
  // Remove nav, ads, footers, sidebars
  $('nav,aside,footer,header,[role=navigation],[role=banner],[role=complementary]').remove();
  $('[class*="sidebar"],[class*="nav"],[class*="menu"],[class*="ad-"],[class*="-ad"],[id*="sidebar"],[id*="ad"]').remove();
  $('script,style,noscript,iframe,form,button,input,select,textarea').remove();

  // Find the biggest block of text
  var best = null, bestLen = 0;
  $('article, [role=main], main, .post-content, .entry-content, .article-body, .story-body, #content, #main-content, .content').each(function() {
    var t = $(this).text().length;
    if (t > bestLen) { bestLen = t; best = $(this); }
  });
  if (!best) best = $('body');

  // Rewrite links and images inside the extracted content
  best.find('a[href]').each(function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#')) return;
    $(this).attr('href', proxyUrl(resolveUrl(targetUrl, href), proxyBase));
  });
  best.find('img[src]').each(function() {
    const src = $(this).attr('src') || $(this).attr('data-src');
    if (!src || src.startsWith('data:')) return;
    $(this).attr('src', `${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, src))}`);
    $(this).removeAttr('srcset');
    $(this).attr('style', 'max-width:100%;height:auto;');
  });
  return best.html() || '<p>Could not extract article content.</p>';
}

// ─── HTML TRANSFORM ──────────────────────────────────────────────────────────

function safeEach($, selector, fn) {
  try { $(selector).each(function() { try { fn.call(this); } catch {} }); } catch {}
}

function transformHTML(html, targetUrl, proxyBase, options) {
  options = options || {};

  // Strip namespaced attributes before cheerio sees them
  html = html.replace(/<[^>]+>/g, tag =>
    tag.replace(/\s[\w-]+:[\w-]+=["'][^"']*["']/g, '')
       .replace(/\s[\w-]+:[\w-]+(?=[\s>\/])/g, '')
  );

  const $ = cheerio.load(html, { decodeEntities: false, xmlMode: false });

  // ── Detect charset from page and re-encode if needed ──
  const charsetMeta = $('meta[charset]').attr('charset') ||
    ($('meta[http-equiv="Content-Type"]').attr('content') || '').match(/charset=([\w-]+)/i)?.[1];

  // ── Remove hostile meta tags ──
  $('meta[name="viewport"]').remove();
  $('meta[http-equiv="X-UA-Compatible"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="refresh"]').each(function() {
    const c = $(this).attr('content') || '';
    const m = c.match(/url=(.+)/i);
    if (m) {
      const dest = resolveUrl(targetUrl, m[1].replace(/['"]/g,'').trim());
      $(this).attr('content', `0;url=${proxyBase}/proxy?url=${encodeURIComponent(dest)}`);
    }
  });

  // ── Remove browser-check / upgrade nags ──
  $('script').each(function() {
    const content = $(this).html() || '';
    if (/unsupported.browser|please upgrade|browserupgrade|outdated.browser|browser.out.of.date/i.test(content)) {
      $(this).remove();
    }
  });
  $('[class*="browser-upgrade"],[class*="outdated"],[id*="browser-upgrade"]').remove();
  $('noscript').remove();

  // ── Remove Web Components / Shadow DOM ──
  $('template').remove();

  // ── picture / srcset → single img ──
  safeEach($, 'picture', function() {
    const img = $(this).find('img').first();
    if (img.length) $(this).replaceWith(img);
    else $(this).remove();
  });
  safeEach($, 'img[srcset]', function() {
    $(this).removeAttr('srcset');
  });
  safeEach($, 'source[srcset]', function() {
    $(this).remove();
  });

  // ── YouTube / Vimeo / Dailymotion iframes → shim ──
  safeEach($, 'iframe[src]', function() {
    const src = $(this).attr('src') || '';
    if (/youtube\.com\/embed|youtu\.be/i.test(src)) {
      const vid = youtubeId(src);
      const title = $(this).attr('title') || 'YouTube Video';
      const thumbUrl = vid ? `https://img.youtube.com/vi/${vid}/mqdefault.jpg` : '';
      const watchUrl = vid ? `https://www.youtube.com/watch?v=${vid}` : src;
      let shimHtml = `<div style="border:1px solid #888;padding:6px;margin:4px 0;background:#f0f0f0;">`;
      shimHtml += `<b>${htmlEsc(title)}</b><br>`;
      if (thumbUrl) shimHtml += `<img src="${proxyBase}/resource?url=${encodeURIComponent(thumbUrl)}" style="max-width:100%;"><br>`;
      shimHtml += `<a href="${proxyBase}/proxy?url=${encodeURIComponent(watchUrl)}">Watch on YouTube</a>`;
      shimHtml += ` &nbsp; <a href="${proxyBase}/proxy?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid + '&feature=player_embedded')}">Mobile player</a>`;
      shimHtml += `</div>`;
      $(this).replaceWith(shimHtml);
    } else if (/vimeo\.com\/video/i.test(src)) {
      $(this).replaceWith(buildVideoShim(proxyBase, src, 'Vimeo Video'));
    } else if (/dailymotion\.com\/embed/i.test(src)) {
      $(this).replaceWith(buildVideoShim(proxyBase, src, 'Dailymotion Video'));
    } else if (/twitch\.tv/i.test(src)) {
      $(this).replaceWith(buildVideoShim(proxyBase, src, 'Twitch Stream'));
    } else {
      // Generic iframe – try to proxy it
      if (!src.startsWith('data:') && !src.startsWith('javascript:')) {
        const abs = resolveUrl(targetUrl, src);
        $(this).attr('src', proxyUrl(abs, proxyBase));
        // Constrain iframe size for 3DS screen
        $(this).attr('width', '380').attr('scrolling', 'yes');
        $(this).removeAttr('height');
      }
    }
  });

  // ── Inline compatibility shims ──
  const ua = MODERN_UA.replace(/'/g, "\\'");
  $('head').prepend(`
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<style>
/* 3DS Proxy global overrides */
*{box-sizing:border-box!important;}
body{max-width:400px!important;margin:0 auto!important;padding:4px!important;font-size:13px!important;font-family:sans-serif!important;}
img{max-width:100%!important;height:auto!important;}
table{max-width:100%!important;word-break:break-word!important;}
pre,code{white-space:pre-wrap!important;word-break:break-all!important;font-size:11px!important;}
input,textarea,select{max-width:100%!important;font-size:13px!important;}
video,audio,embed,object{display:none!important;}
/* Flex/grid reset */
[style*="display:flex"],[style*="display: flex"]{display:block!important;}
[style*="display:grid"],[style*="display: grid"]{display:block!important;}
</style>
<script>
/* 3DS Mega Proxy Shims v3 */
try{navigator.__defineGetter__('userAgent',function(){return '${ua}';});}catch(e){}
window.chrome=window.chrome||{};
window.CSS=window.CSS||{supports:function(){return false;}};
window.CustomEvent=window.CustomEvent||function(e,p){p=p||{};var ev=document.createEvent('Event');ev.initEvent(e,!!p.bubbles,!!p.cancelable);ev.detail=p.detail||null;return ev;};
window.WeakMap=window.WeakMap||function(){var k=[],v=[];this.set=function(a,b){k.push(a);v.push(b);};this.get=function(a){return v[k.indexOf(a)];};this.has=function(a){return k.indexOf(a)>=0;};};
window.WeakSet=window.WeakSet||function(){var s=[];this.add=function(a){if(s.indexOf(a)<0)s.push(a);};this.has=function(a){return s.indexOf(a)>=0;};this.delete=function(a){var i=s.indexOf(a);if(i>=0)s.splice(i,1);};};
window.Symbol=window.Symbol||function(d){return '__sym_'+(d||'')+'_'+Math.random().toString(36).slice(2);};
window.Symbol.iterator=window.Symbol.iterator||'__sym_iterator__';
window.Map=window.Map||function(){var k=[],v=[];this.set=function(a,b){var i=k.indexOf(a);if(i<0){k.push(a);v.push(b);}else{v[i]=b;}return this;};this.get=function(a){return v[k.indexOf(a)];};this.has=function(a){return k.indexOf(a)>=0;};this.delete=function(a){var i=k.indexOf(a);if(i>=0){k.splice(i,1);v.splice(i,1);}};this.forEach=function(fn){for(var i=0;i<k.length;i++)fn(v[i],k[i],this);};Object.defineProperty(this,'size',{get:function(){return k.length;}});};
window.Set=window.Set||function(){var s=[];this.add=function(a){if(s.indexOf(a)<0)s.push(a);return this;};this.has=function(a){return s.indexOf(a)>=0;};this.delete=function(a){var i=s.indexOf(a);if(i>=0)s.splice(i,1);};this.forEach=function(fn){s.forEach(fn);};Object.defineProperty(this,'size',{get:function(){return s.length;}});};
if(!window.Promise){window.Promise=function(fn){this._cbs=[];this._ecbs=[];var self=this;this.then=function(cb){if(cb)self._cbs.push(cb);return self;};this.catch=function(cb){if(cb)self._ecbs.push(cb);return self;};try{fn(function(v){self._cbs.forEach(function(c){try{c(v);}catch(e){}});},function(e){self._ecbs.forEach(function(c){try{c(e);}catch(ex){}});});}catch(e){}};window.Promise.resolve=function(v){return new window.Promise(function(res){res(v);});};window.Promise.reject=function(v){return new window.Promise(function(_,rej){rej(v);});};window.Promise.all=function(arr){return new window.Promise(function(res){res(arr);});};window.Promise.race=function(arr){return new window.Promise(function(res){if(arr.length)res(arr[0]);});};};
if(!window.fetch){window.fetch=function(url,opts){return new window.Promise(function(res,rej){var x=new XMLHttpRequest();x.open((opts&&opts.method)||'GET',url,true);x.onload=function(){res({ok:x.status>=200&&x.status<300,status:x.status,text:function(){return window.Promise.resolve(x.responseText);},json:function(){return window.Promise.resolve(JSON.parse(x.responseText));}});};x.onerror=function(){rej(new Error('fetch failed'));};x.send(opts&&opts.body||null);});};}
if(!Array.prototype.forEach){Array.prototype.forEach=function(fn){for(var i=0;i<this.length;i++)fn(this[i],i,this);};}
if(!Array.prototype.map){Array.prototype.map=function(fn){var r=[];for(var i=0;i<this.length;i++)r.push(fn(this[i],i,this));return r;};}
if(!Array.prototype.filter){Array.prototype.filter=function(fn){var r=[];for(var i=0;i<this.length;i++)if(fn(this[i],i,this))r.push(this[i]);return r;};}
if(!Array.prototype.reduce){Array.prototype.reduce=function(fn,init){var acc=init,i=0;if(arguments.length<2){acc=this[0];i=1;}for(;i<this.length;i++)acc=fn(acc,this[i],i,this);return acc;};}
if(!Array.prototype.find){Array.prototype.find=function(fn){for(var i=0;i<this.length;i++)if(fn(this[i],i,this))return this[i];return undefined;};}
if(!Array.prototype.findIndex){Array.prototype.findIndex=function(fn){for(var i=0;i<this.length;i++)if(fn(this[i],i,this))return i;return -1;};}
if(!Array.prototype.includes){Array.prototype.includes=function(v){return this.indexOf(v)>=0;};}
if(!Array.from){Array.from=function(a){var r=[];for(var i=0;i<a.length;i++)r.push(a[i]);return r;};}
if(!Object.assign){Object.assign=function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s)for(var k in s)if(Object.prototype.hasOwnProperty.call(s,k))t[k]=s[k];}return t;};}
if(!Object.keys){Object.keys=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(k);return r;};}
if(!Object.values){Object.values=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(o[k]);return r;};}
if(!Object.entries){Object.entries=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push([k,o[k]]);return r;};}
if(!String.prototype.includes){String.prototype.includes=function(s){return this.indexOf(s)>=0;};}
if(!String.prototype.startsWith){String.prototype.startsWith=function(s){return this.indexOf(s)===0;};}
if(!String.prototype.endsWith){String.prototype.endsWith=function(s){return this.slice(-s.length)===s;};}
if(!String.prototype.repeat){String.prototype.repeat=function(n){var r='';for(var i=0;i<n;i++)r+=this;return r;};}
if(!String.prototype.trim){String.prototype.trim=function(){return this.replace(/^\\s+|\\s+$/g,'');};}
if(!Number.isInteger){Number.isInteger=function(v){return typeof v==='number'&&isFinite(v)&&Math.floor(v)===v;};}
if(!Number.isNaN){Number.isNaN=function(v){return v!==v;};}
if(!Math.sign){Math.sign=function(v){return v>0?1:v<0?-1:0;};}
if(!Math.trunc){Math.trunc=function(v){return v<0?Math.ceil(v):Math.floor(v);};}
if(!window.requestAnimationFrame){window.requestAnimationFrame=function(cb){return setTimeout(cb,16);};}
if(!window.cancelAnimationFrame){window.cancelAnimationFrame=clearTimeout;}
if(!window.getComputedStyle){window.getComputedStyle=function(el){return el.style;};}
if(!window.history){window.history={pushState:function(){},replaceState:function(){},back:function(){history.go(-1);}};}
if(!window.sessionStorage){try{window.sessionStorage={_d:{},getItem:function(k){return this._d[k]||null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};}};}catch(e){}}
if(!window.localStorage){try{window.localStorage={_d:{},getItem:function(k){return this._d[k]||null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};}};}catch(e){}}
if(!window.MutationObserver){window.MutationObserver=function(){this.observe=function(){};this.disconnect=function(){};this.takeRecords=function(){return[];};};}
if(!window.IntersectionObserver){window.IntersectionObserver=function(cb){this.observe=function(){};this.unobserve=function(){};this.disconnect=function(){};};}
if(!window.ResizeObserver){window.ResizeObserver=function(cb){this.observe=function(){};this.unobserve=function(){};this.disconnect=function(){};};}
if(!window.matchMedia){window.matchMedia=function(){return{matches:false,addListener:function(){},removeListener:function(){}};};}
if(!window.console){window.console={log:function(){},warn:function(){},error:function(){},info:function(){}};}
if(!document.querySelector){document.querySelector=function(s){try{return document.getElementById(s.replace('#',''));}catch(e){return null;}};}
if(!document.querySelectorAll){document.querySelectorAll=function(){return[];};}
if(!Element.prototype.classList){Object.defineProperty(Element.prototype,'classList',{get:function(){var el=this;return{_c:(el.className||'').split(' '),add:function(c){if(!this.contains(c))el.className+=' '+c;},remove:function(c){el.className=el.className.replace(new RegExp('\\\\b'+c+'\\\\b','g'),'').trim();},contains:function(c){return(' '+el.className+' ').indexOf(' '+c+' ')>=0;},toggle:function(c){this.contains(c)?this.remove(c):this.add(c);}};},enumerable:false});}
if(!Element.prototype.closest){Element.prototype.closest=function(s){var el=this;while(el&&el.nodeType===1){try{if(el.matches&&el.matches(s))return el;}catch(e){}el=el.parentElement||el.parentNode;}return null;};}
if(!Element.prototype.remove){Element.prototype.remove=function(){if(this.parentNode)this.parentNode.removeChild(this);};}
/* Proxy history.pushState to reroute through our proxy */
(function(){
  var _push=history.pushState;
  history.pushState=function(state,title,url){
    if(url){
      var abs=url.indexOf('http')===0?url:'${targetUrl.replace(/'/g,"\\'").split('/').slice(0,3).join('/')}'+url;
      window.location.href='${proxyBase}/proxy?url='+encodeURIComponent(abs);
      return;
    }
    try{return _push.apply(this,arguments);}catch(e){}
  };
  var _replace=history.replaceState;
  history.replaceState=function(state,title,url){
    if(url&&url.indexOf('http')===0){
      window.location.href='${proxyBase}/proxy?url='+encodeURIComponent(url);
      return;
    }
    try{return _replace.apply(this,arguments);}catch(e){}
  };
})();
/* Intercept window.open */
var _open=window.open;
window.open=function(url,name,features){
  if(url&&url.indexOf('http')===0)window.location.href='${proxyBase}/proxy?url='+encodeURIComponent(url);
  else if(url)_open.call(window,url,name,features);
};
</script>
`);

  // ── Proxy bar (injected at top of body) ──
  const currentEncoded = encodeURIComponent(targetUrl);
  const bodyBar = `
<div id="__3ds_bar" style="background:#224;color:#fff;padding:4px;font-size:11px;position:relative;z-index:9999;margin-bottom:4px;">
<a href="/" style="color:#adf;text-decoration:none;">&#8962; Home</a>
&nbsp;
<a href="${proxyBase}/history" style="color:#adf;">&#128221; History</a>
&nbsp;
<a href="${proxyBase}/bookmarks" style="color:#adf;">&#9733; Marks</a>
&nbsp;
<a href="${proxyBase}/reader?url=${currentEncoded}" style="color:#adf;">&#128196; Reader</a>
&nbsp;
<a href="${proxyBase}/translate?url=${currentEncoded}&lang=es" style="color:#adf;">&#127760; Translate</a>
<br>
<form method="GET" action="/go" style="margin:3px 0 0;">
<input name="q" value="${htmlEsc(targetUrl)}" style="width:75%;font-size:11px;padding:2px;">
<input type="submit" value="Go" style="font-size:11px;padding:2px 4px;">
</form>
<span style="font-size:10px;color:#aaa;">
<a href="${proxyBase}/add-bookmark?url=${currentEncoded}&title=${encodeURIComponent($('title').text()||targetUrl)}" style="color:#ffa;">+ Bookmark</a>
&nbsp;|&nbsp;
<a href="${proxyBase}/simplify?url=${currentEncoded}" style="color:#ffa;">&#9881; Simplify</a>
&nbsp;|&nbsp;
<a href="${proxyBase}/translate?url=${currentEncoded}&lang=en" style="color:#ffa;">&#127760; EN</a>
</span>
</div>`;

  $('body').prepend(bodyBar);

  // ── Links ──
  safeEach($, 'a[href]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    if (href.startsWith(`${proxyBase}/`)) return; // already proxied
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', proxyUrl(abs, proxyBase));
    $(this).removeAttr('target'); // no new windows
  });

  // ── Forms ──
  safeEach($, 'form', function() {
    const action = $(this).attr('action') || targetUrl;
    const method = ($(this).attr('method') || 'GET').toUpperCase();
    const abs = resolveUrl(targetUrl, action);
    if (method === 'GET') {
      $(this).attr('action', `${proxyBase}/form-get`);
      $(this).prepend(`<input type="hidden" name="__proxy_url" value="${htmlEsc(abs)}">`);
    } else {
      $(this).attr('action', `${proxyBase}/form-post?url=${encodeURIComponent(abs)}`);
    }
    $(this).removeAttr('onsubmit');
  });

  // ── Script src ──
  safeEach($, 'script[src]', function() {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, src);
    $(this).attr('src', `${proxyBase}/js?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(targetUrl)}`);
  });

  // ── Inline scripts ──
  safeEach($, 'script:not([src])', function() {
    const type = $(this).attr('type') || '';
    if (type && !/javascript|text\/javascript|text\/ecmascript/i.test(type)) {
      $(this).remove(); return; // remove module / json-ld / etc.
    }
    const content = $(this).html() || '';
    $(this).html(transformJS(content, proxyBase, targetUrl));
  });

  // ── Stylesheets ──
  safeEach($, 'link[rel="stylesheet"]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}`);
  });

  // ── Inline styles ──
  safeEach($, '[style]', function() {
    const style = $(this).attr('style') || '';
    const rewritten = style
      .replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (m, u) => {
        if (u.startsWith('data:') || u.startsWith('#')) return m;
        const abs = resolveUrl(targetUrl, u);
        return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
      })
      // Neutralise flex/grid in inline styles
      .replace(/display\s*:\s*(flex|grid|inline-flex|inline-grid)/g, 'display:block')
      .replace(/grid-[^:;]+:[^;]+;?/g, '')
      .replace(/flex[^:;]*:[^;]+;?/g, '');
    $(this).attr('style', rewritten);
  });

  // ── Images ──
  const srcAttrs = [
    ['img', 'src'], ['img', 'data-src'], ['img', 'data-lazy-src'],
    ['source', 'src'], ['video', 'poster'],
    ['audio', 'src'], ['track', 'src']
  ];
  for (const [sel, attr] of srcAttrs) {
    safeEach($, sel, function() {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:')) return;
      const abs = resolveUrl(targetUrl, val);
      $(this).attr(attr, `${proxyBase}/resource?url=${encodeURIComponent(abs)}`);
    });
  }

  // ── Remove autoplay / preload on media ──
  $('video,audio').removeAttr('autoplay').removeAttr('preload').attr('controls', '');

  // ── Favicon proxy ──
  safeEach($, 'link[rel*="icon"]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/resource?url=${encodeURIComponent(abs)}`);
  });

  // ── Preload / prefetch links — remove (waste bandwidth) ──
  $('link[rel="preload"], link[rel="prefetch"], link[rel="preconnect"], link[rel="dns-prefetch"]').remove();

  // ── Remove heavy/useless elements ──
  $('canvas,svg>use').remove();

  return $.html();
}

// ─── SEARCH: DuckDuckGo Lite ─────────────────────────────────────────────────

async function fetchDDGLite(q, page) {
  page = page || 1;
  const url = 'https://lite.duckduckgo.com/lite/';
  const params = new urlModule.URLSearchParams({ q, s: String((page - 1) * 30), dc: String((page - 1) * 30 + 1), o: 'json', api: 'd.js' });
  const r = await axios.post(url, params.toString(), {
    headers: {
      'User-Agent'   : MODERN_UA,
      'Content-Type' : 'application/x-www-form-urlencoded',
      'Accept'       : 'text/html,application/xhtml+xml,*/*',
      'Referer'      : 'https://lite.duckduckgo.com/'
    },
    timeout: 12000,
    responseType: 'arraybuffer',
    validateStatus: () => true
  });
  return r.data.toString('utf-8');
}

function parseDDGLite(html) {
  const $ = cheerio.load(html);
  const results = [];
  // DDG lite uses a table-based layout
  $('table').each(function() {
    $(this).find('tr').each(function() {
      const link = $(this).find('a.result-link');
      if (!link.length) return;
      const title = link.text().trim();
      const url   = link.attr('href') || '';
      const snippet = $(this).find('.result-snippet').text().trim() ||
                      $(this).next('tr').find('.result-snippet').text().trim();
      if (url && title) results.push({ title, url: url.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/,''), snippet });
    });
  });
  // Alternative: DDG Lite sometimes uses <a class="result-link">
  if (results.length === 0) {
    $('a.result-link').each(function() {
      const title = $(this).text().trim();
      const raw = $(this).attr('href') || '';
      // Decode DDG redirect URL
      let url = raw;
      try { url = decodeURIComponent(raw.split('uddg=')[1] || raw); } catch {}
      const snippet = $(this).closest('tr').next('tr').find('td').text().trim();
      if (url && title) results.push({ title, url, snippet });
    });
  }
  return results;
}

// ─── HOME PAGE ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>3DS Mega Proxy</title>
<style>
body{font-family:sans-serif;padding:8px;background:#dde;max-width:400px;margin:0 auto;}
h2{color:#224;margin:4px 0;}
input[name=q]{width:74%;padding:4px;font-size:13px;}
input[type=submit]{padding:4px 8px;font-size:13px;}
.links a{display:inline-block;margin:4px 4px 0 0;padding:3px 7px;background:#446;color:#fff;text-decoration:none;font-size:12px;border-radius:3px;}
.sec{margin:6px 0;padding:6px;background:#fff;border:1px solid #aab;font-size:12px;}
.sec b{display:block;color:#335;margin-bottom:3px;}
</style>
</head>
<body>
<h2>&#127918; 3DS Mega Proxy</h2>
<form method="GET" action="/go">
<input name="q" placeholder="URL or search term" autocomplete="off">
<input type="submit" value="Go">
</form>

<div class="links">
<a href="/search?q=news+today">News</a>
<a href="/wiki?q=Main_Page">Wikipedia</a>
<a href="/images?q=cats">Images</a>
<a href="/weather?q=New+York">Weather</a>
<a href="/rss?url=https%3A%2F%2Ffeeds.bbci.co.uk%2Fnews%2Frss.xml">BBC RSS</a>
<a href="/bookmarks">&#9733; Bookmarks</a>
<a href="/history">&#128221; History</a>
<a href="/help">&#10067; Help</a>
</div>

<div class="sec">
<b>&#128270; Quick Search</b>
<a href="/images?q=">Image Search</a> &bull;
<a href="/wiki?q=">Wikipedia</a> &bull;
<a href="/proxy?url=https%3A%2F%2Flite.duckduckgo.com%2Flite%2F">DDG Lite</a>
</div>

<div class="sec">
<b>&#127760; Quick Sites (3DS-friendly)</b>
<a href="/proxy?url=https%3A%2F%2Fold.reddit.com">old.reddit</a> &bull;
<a href="/proxy?url=https%3A%2F%2Fnitter.net">Nitter (Twitter)</a> &bull;
<a href="/proxy?url=https%3A%2F%2Fen.m.wikipedia.org">Wikipedia Mobile</a> &bull;
<a href="/proxy?url=https%3A%2F%2Flite.duckduckgo.com%2Flite%2F">DuckDuckGo Lite</a> &bull;
<a href="/proxy?url=https%3A%2F%2Ftext.npr.org">NPR Text</a> &bull;
<a href="/proxy?url=https%3A%2F%2Fwww.bbc.com%2Fnews">BBC News</a> &bull;
<a href="/proxy?url=https%3A%2F%2Fhnews.xyz">HN Reader</a> &bull;
<a href="/proxy?url=https%3A%2F%2Fwww.gutenberg.org">Project Gutenberg</a> &bull;
<a href="/proxy?url=https%3A%2F%2Farchive.org">Internet Archive</a>
</div>

<div class="sec">
<b>&#128196; Tools</b>
<form method="GET" action="/translate" style="display:inline;">
  URL: <input name="url" placeholder="https://..." style="width:60%;font-size:11px;">
  Lang: <select name="lang" style="font-size:11px;"><option value="en">EN</option><option value="es">ES</option><option value="fr">FR</option><option value="de">DE</option><option value="it">IT</option><option value="ja">JA</option><option value="zh">ZH</option><option value="pt">PT</option><option value="ru">RU</option><option value="ar">AR</option><option value="ko">KO</option></select>
  <input type="submit" value="Translate" style="font-size:11px;">
</form><br>
<form method="GET" action="/rss" style="display:inline;">
  RSS URL: <input name="url" placeholder="https://...feed.xml" style="width:60%;font-size:11px;">
  <input type="submit" value="Read RSS" style="font-size:11px;">
</form>
</div>

<p style="font-size:10px;color:#668;margin-top:8px;">
3DS Mega Proxy v3.0 &bull; All traffic proxied server-side &bull;
Cookies forwarded per domain &bull; Cache: 5 min
</p>
</body>
</html>`);
});

// ─── /go – smart dispatcher ──────────────────────────────────────────────────

app.get('/go', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');
  if (/^https?:\/\//i.test(q) || /^[\w-]+\.\w{2,}(\/|$)/.test(q)) {
    const target = /^https?:\/\//i.test(q) ? q : 'http://' + q;
    return res.redirect(`/proxy?url=${encodeURIComponent(target)}`);
  }
  // Check for special prefixes
  if (/^wiki:/i.test(q)) return res.redirect(`/wiki?q=${encodeURIComponent(q.slice(5))}`);
  if (/^img:/i.test(q) || /^image:/i.test(q)) return res.redirect(`/images?q=${encodeURIComponent(q.slice(q.indexOf(':')+1))}`);
  if (/^weather:/i.test(q)) return res.redirect(`/weather?q=${encodeURIComponent(q.slice(8))}`);
  if (/^rss:/i.test(q)) return res.redirect(`/rss?url=${encodeURIComponent(q.slice(4))}`);
  return res.redirect(`/search?q=${encodeURIComponent(q)}`);
});

// ─── MAIN PROXY ──────────────────────────────────────────────────────────────

app.get('/proxy', async (req, res) => {
  let targetUrl = (req.query.url || '').trim();
  if (!targetUrl) return res.redirect('/');
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'http://' + targetUrl;

  targetUrl = rewriteTargetUrl(targetUrl);

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  // Record history
  try {
    const sess = getSession(req, res);
    const title = new urlModule.URL(targetUrl).hostname;
    sess.history.unshift({ url: targetUrl, title, ts: Date.now() });
    if (sess.history.length > MAX_HIST) sess.history.length = MAX_HIST;
  } catch {}

  // Check cache
  const cached = cacheGet(targetUrl);
  if (cached && !req.query.nocache) {
    res.setHeader('Content-Type', cached.ct);
    res.setHeader('X-3DS-Cache', 'HIT');
    return res.send(cached.data);
  }

  try {
    const response = await proxyFetch(targetUrl);
    const status   = response.status;

    // Store cookies from response
    try {
      const host = new urlModule.URL(targetUrl).hostname;
      storeCookies(host, response.headers['set-cookie']);
    } catch {}

    // Follow redirects
    if (status >= 300 && status < 400 && response.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, response.headers.location);
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      // iconv fallback for non-UTF8 pages
      const enc = contentType.match(/charset=([\w-]+)/)?.[1];
      if (enc && !/utf-?8/i.test(enc)) {
        try { html = iconv.decode(response.data, enc); } catch {}
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      let out;
      try { out = transformHTML(html, targetUrl, proxyBase); }
      catch (e) { out = `<!-- transform error: ${e.message} -->\n` + html; }
      cacheSet(targetUrl, out, 'text/html; charset=utf-8');
      return res.send(out);
    }

    if (contentType.includes('text/css')) {
      const raw = response.data.toString('utf-8');
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      const out = transformCSS(raw, targetUrl, proxyBase);
      cacheSet(targetUrl, out, 'text/css; charset=utf-8');
      return res.send(out);
    }

    if (contentType.includes('javascript')) {
      const raw = response.data.toString('utf-8');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      const out = transformJS(raw, proxyBase, targetUrl);
      return res.send(out);
    }

    // Binary passthrough
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    // Show download page for big binary files
    const cl = parseInt(response.headers['content-length'] || '0');
    if (cl > 500000 && !contentType.includes('image')) {
      const fname = targetUrl.split('/').pop().split('?')[0] || 'file';
      return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Download</title></head><body>
<h3>&#128190; Download File</h3>
<p><b>File:</b> ${htmlEsc(fname)}</p>
<p><b>Size:</b> ${Math.round(cl/1024)} KB</p>
<p><b>Type:</b> ${htmlEsc(contentType)}</p>
<a href="${proxyBase}/resource?url=${encodeURIComponent(targetUrl)}">&#128229; Download</a>
&nbsp; <a href="/">Home</a>
</body></html>`);
    }
    return res.send(response.data);

  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><title>Proxy Error</title></head><body>
<h3>&#9888; Proxy Error</h3>
<p>${htmlEsc(err.message)}</p>
<p>URL: <code>${htmlEsc(targetUrl)}</code></p>
<a href="javascript:history.back()">&#8592; Back</a> &nbsp; <a href="/">Home</a>
<br><br><a href="${proxyBase}/reader?url=${encodeURIComponent(targetUrl)}">Try Reader Mode</a>
</body></html>`);
  }
});

// ─── SEARCH (DuckDuckGo Lite primary, fallback SearX) ────────────────────────

app.get('/search', async (req, res) => {
  const q    = (req.query.q || '').trim();
  const page = parseInt(req.query.p || '1') || 1;
  if (!q) return res.redirect('/');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page + 1;

  const pageLinks = `
<p style="font-size:11px;">
${prevPage ? `<a href="/search?q=${encodeURIComponent(q)}&p=${prevPage}">&#8592; Prev</a> &nbsp;` : ''}
Page ${page}
&nbsp; <a href="/search?q=${encodeURIComponent(q)}&p=${nextPage}">Next &#8594;</a>
</p>`;

  function buildSearchPage(results, source) {
    let html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Search: ${htmlEsc(q)}</title>
<style>
body{font-family:sans-serif;padding:6px;background:#f2f2f2;max-width:400px;margin:0 auto;font-size:13px;}
.r{margin-bottom:8px;padding:5px;background:#fff;border:1px solid #ccc;}
.r a{color:#00c;font-size:13px;font-weight:bold;}
.r small{color:#080;display:block;font-size:10px;word-break:break-all;}
.r p{margin:2px 0 0;color:#333;font-size:11px;}
.r .qs{font-size:10px;color:#666;}
form input[name=q]{width:74%;padding:3px;font-size:12px;}
.tabs a{display:inline-block;padding:3px 7px;margin-right:3px;background:#ccd;font-size:12px;text-decoration:none;color:#224;}
.tabs a.sel{background:#224;color:#fff;}
.src{font-size:10px;color:#888;margin-bottom:4px;}
</style>
</head><body>
<form method="GET" action="/search">
<input name="q" value="${htmlEsc(q)}">
<input type="submit" value="Search">
</form>
<div class="tabs">
<a class="sel" href="/search?q=${encodeURIComponent(q)}">Web</a>
<a href="/images?q=${encodeURIComponent(q)}">Images</a>
<a href="/wiki?q=${encodeURIComponent(q)}">Wikipedia</a>
<a href="/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q='+encodeURIComponent(q))}">DDG&nbsp;Lite</a>
</div>
<p class="src">Results via ${htmlEsc(source)} &bull; Page ${page}</p>`;

    if (results.length === 0) {
      html += `<p>No results. <a href="/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q='+encodeURIComponent(q))}">Try DDG Lite directly</a></p>`;
    } else {
      results.forEach(r => {
        const title   = htmlEsc(r.title || r.url || '(no title)').substring(0, 100);
        const snippet = htmlEsc((r.snippet || r.content || '').substring(0, 200));
        const domain  = (() => { try { return new urlModule.URL(r.url).hostname; } catch { return ''; } })();
        const proxied = `${proxyBase}/proxy?url=${encodeURIComponent(r.url)}`;
        const reader  = `${proxyBase}/reader?url=${encodeURIComponent(r.url)}`;
        html += `<div class="r">
<a href="${proxied}">${title}</a>
<small>${htmlEsc(domain)}</small>
${snippet ? `<p>${snippet}</p>` : ''}
<span class="qs"><a href="${reader}">Reader</a> &bull; <a href="${proxyBase}/add-bookmark?url=${encodeURIComponent(r.url)}&title=${encodeURIComponent(r.title||r.url)}">+Mark</a></span>
</div>`;
      });
    }
    html += pageLinks;
    html += `<a href="/">&#8962; Home</a></body></html>`;
    return html;
  }

  // Try DDG Lite first
  try {
    const ddgHtml = await fetchDDGLite(q, page);
    const results = parseDDGLite(ddgHtml);
    if (results.length > 0) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(buildSearchPage(results, 'DuckDuckGo Lite'));
    }
  } catch (e) {
    // fall through to SearX
  }

  // Fallback: SearX instances
  const INSTANCES = [
    'https://searx.be', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://paulgo.io', 'https://searx.info'
  ];
  for (const inst of INSTANCES) {
    try {
      const r = await axios.get(`${inst}/search`, {
        params: { q, format: 'json', pageno: page },
        headers: { 'User-Agent': MODERN_UA },
        timeout: 8000
      });
      if (r.data && r.data.results && r.data.results.length > 0) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(buildSearchPage(r.data.results.slice(0, 12).map(x => ({
          title: x.title, url: x.url, snippet: x.content
        })), inst));
      }
    } catch {}
  }

  // Total failure
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><body>
<h3>Search failed</h3>
<p>All providers timed out.</p>
<p><a href="${proxyBase}/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q='+encodeURIComponent(q))}">Try DuckDuckGo Lite directly</a></p>
<a href="/">Home</a>
</body></html>`);
});

// ─── IMAGE SEARCH ────────────────────────────────────────────────────────────

app.get('/images', async (req, res) => {
  const q = (req.query.q || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!q) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Image Search</title></head><body>
<h3>&#128247; Image Search</h3>
<form method="GET" action="/images"><input name="q" placeholder="Search images"><input type="submit" value="Search"></form>
<a href="/">Home</a></body></html>`);
  }

  // Use DDG HTML image search (no API key needed)
  try {
    const r = await axios.get(`https://duckduckgo.com/`, {
      params: { q, iax: 'images', ia: 'images' },
      headers: { 'User-Agent': MODERN_UA },
      timeout: 10000,
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
    // DDG image search returns JS – parse vqd token then fetch image API
    const body = r.data.toString('utf-8');
    const vqd = (body.match(/vqd=['"]([^'"]+)['"]/)||[])[1] ||
                (body.match(/vqd=([^&'";\s]+)/)||[])[1];

    if (vqd) {
      const ir = await axios.get('https://duckduckgo.com/i.js', {
        params: { l: 'us-en', o: 'json', q, vqd, f: ',,,,,', p: '1' },
        headers: { 'User-Agent': MODERN_UA, Referer: 'https://duckduckgo.com/' },
        timeout: 10000,
        validateStatus: () => true
      });
      const imgs = (ir.data && ir.data.results) ? ir.data.results.slice(0, 20) : [];
      let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Images: ${htmlEsc(q)}</title>
<style>
body{font-family:sans-serif;padding:4px;max-width:400px;margin:0 auto;}
.ig{display:inline-block;margin:3px;vertical-align:top;width:120px;text-align:center;font-size:10px;}
.ig img{max-width:120px;max-height:90px;border:1px solid #ccc;}
</style>
</head><body>
<form method="GET" action="/images"><input name="q" value="${htmlEsc(q)}" style="width:72%;font-size:12px;"><input type="submit" value="Search"></form>
<p><a href="/search?q=${encodeURIComponent(q)}">Web</a> | <b>Images</b> | <a href="/wiki?q=${encodeURIComponent(q)}">Wiki</a></p>
<p style="font-size:11px;">${imgs.length} results</p>`;
      imgs.forEach(img => {
        const thumb = img.thumbnail || img.image;
        const title = htmlEsc((img.title||'').substring(0,40));
        const source = img.url || img.image;
        html += `<div class="ig">
<a href="${proxyBase}/proxy?url=${encodeURIComponent(source)}">
<img src="${proxyBase}/resource?url=${encodeURIComponent(thumb)}" alt="${title}">
</a><br>${title}
</div>`;
      });
      html += `<br><a href="/">Home</a></body></html>`;
      return res.send(html);
    }
  } catch {}

  // Fallback: link to DDG image search via proxy
  res.send(`<!DOCTYPE html><html><body>
<p>Image search unavailable. <a href="${proxyBase}/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q='+encodeURIComponent(q)+'+images')}">Try text search</a></p>
<a href="/">Home</a></body></html>`);
});

// ─── WIKIPEDIA QUICK-LOOK ────────────────────────────────────────────────────

app.get('/wiki', async (req, res) => {
  const q = (req.query.q || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!q) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Wikipedia</title></head><body>
<h3>&#128218; Wikipedia</h3>
<form method="GET" action="/wiki"><input name="q" placeholder="Search Wikipedia"><input type="submit" value="Search"></form>
<a href="/">Home</a></body></html>`);
  }

  try {
    // First try exact article via REST API (summary)
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
    const sr = await axios.get(summaryUrl, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 8000,
      validateStatus: () => true
    });

    if (sr.status === 200 && sr.data.extract) {
      const d = sr.data;
      const thumb = d.thumbnail ? `<img src="${proxyBase}/resource?url=${encodeURIComponent(d.thumbnail.source)}" style="max-width:100%;float:right;margin:0 0 4px 4px;">` : '';
      const pageUrl = d.content_urls && d.content_urls.desktop ? d.content_urls.desktop.page : `https://en.wikipedia.org/wiki/${encodeURIComponent(q)}`;
      const mobileUrl = d.content_urls && d.content_urls.mobile ? d.content_urls.mobile.page : pageUrl;

      return res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Wiki: ${htmlEsc(d.title)}</title>
<style>body{font-family:sans-serif;padding:6px;max-width:400px;margin:0 auto;font-size:13px;}img{max-width:180px!important;}</style>
</head><body>
<form method="GET" action="/wiki"><input name="q" value="${htmlEsc(q)}" style="width:72%;font-size:11px;"><input type="submit" value="Search"></form>
<h3>${htmlEsc(d.title)}</h3>
${thumb}
<p>${htmlEsc(d.description||'')}</p>
<p>${htmlEsc(d.extract)}</p>
<p>
<a href="${proxyBase}/proxy?url=${encodeURIComponent(mobileUrl)}">Full mobile article</a> &bull;
<a href="${proxyBase}/reader?url=${encodeURIComponent(mobileUrl)}">Reader mode</a>
</p>
<a href="/">Home</a>
</body></html>`);
    }

    // Search Wikipedia
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&utf8=1&srlimit=8`;
    const ss = await axios.get(searchUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 8000 });
    const items = (ss.data.query && ss.data.query.search) || [];
    let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Wiki Search: ${htmlEsc(q)}</title>
<style>body{font-family:sans-serif;padding:6px;max-width:400px;font-size:13px;}.r{padding:4px;border-bottom:1px solid #ccc;}</style>
</head><body>
<form method="GET" action="/wiki"><input name="q" value="${htmlEsc(q)}" style="width:72%;font-size:11px;"><input type="submit" value="Search"></form>
<h3>Wikipedia: "${htmlEsc(q)}"</h3>`;
    items.forEach(item => {
      const title = htmlEsc(item.title);
      const snippet = htmlEsc(item.snippet.replace(/<[^>]+>/g,'').substring(0,150));
      html += `<div class="r">
<a href="/wiki?q=${encodeURIComponent(item.title)}">${title}</a><br>
<small>${snippet}</small>
</div>`;
    });
    html += `<a href="/">Home</a></body></html>`;
    return res.send(html);

  } catch (e) {
    res.send(`<!DOCTYPE html><html><body><p>Wikipedia error: ${htmlEsc(e.message)}</p><a href="/">Home</a></body></html>`);
  }
});

// ─── READER MODE ─────────────────────────────────────────────────────────────

app.get('/reader', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!targetUrl) return res.redirect('/');

  try {
    const r = await proxyFetch(targetUrl);
    const contentType = (r.headers['content-type'] || '').toLowerCase();
    let html = r.data.toString('utf-8');
    const enc = contentType.match(/charset=([\w-]+)/)?.[1];
    if (enc && !/utf-?8/i.test(enc)) {
      try { html = iconv.decode(r.data, enc); } catch {}
    }

    const $ = cheerio.load(html, { decodeEntities: false });
    const pageTitle = $('title').text() || targetUrl;
    const content   = extractReadableContent($, targetUrl, proxyBase);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Reader: ${htmlEsc(pageTitle)}</title>
<style>
body{font-family:Georgia,serif;padding:8px;max-width:400px;margin:0 auto;font-size:14px;line-height:1.6;color:#111;}
img{max-width:100%;height:auto;}
h1,h2,h3{font-size:16px;color:#223;}
a{color:#06c;}
.bar{font-size:11px;background:#eff;padding:4px;margin-bottom:8px;border:1px solid #aac;}
</style>
</head><body>
<div class="bar">
<a href="${proxyBase}/proxy?url=${encodeURIComponent(targetUrl)}">&#8678; Full Page</a> &bull;
<a href="${proxyBase}/translate?url=${encodeURIComponent(targetUrl)}&lang=es">Translate</a> &bull;
<a href="/">Home</a><br>
<small>${htmlEsc(targetUrl.substring(0,60))}</small>
</div>
<h2>${htmlEsc(pageTitle)}</h2>
${content}
<hr>
<a href="${proxyBase}/proxy?url=${encodeURIComponent(targetUrl)}">Full Page</a> &bull; <a href="/">Home</a>
</body></html>`);
  } catch (e) {
    res.send(`<html><body><p>Reader mode error: ${htmlEsc(e.message)}</p><a href="/">Home</a></body></html>`);
  }
});

// ─── PAGE SIMPLIFIER ─────────────────────────────────────────────────────────

app.get('/simplify', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  if (!targetUrl) return res.redirect('/');

  try {
    const r = await proxyFetch(targetUrl);
    let html = r.data.toString('utf-8');
    const $ = cheerio.load(html, { decodeEntities: false });

    // Strip everything except text and links
    $('script,style,link,meta,noscript,iframe,video,audio,canvas,svg,form').remove();
    $('[style]').removeAttr('style');
    $('[class]').removeAttr('class');
    $('[id]').removeAttr('id');

    $('a[href]').each(function() {
      const href = $(this).attr('href');
      if (!href || href.startsWith('#')) return;
      const abs = resolveUrl(targetUrl, href);
      $(this).attr('href', proxyUrl(abs, proxyBase));
    });

    $('img[src]').each(function() {
      const src = $(this).attr('src') || $(this).attr('data-src');
      if (!src || src.startsWith('data:')) { $(this).remove(); return; }
      const abs = resolveUrl(targetUrl, src);
      $(this).attr('src', `${proxyBase}/resource?url=${encodeURIComponent(abs)}`);
      $(this).attr('style', 'max-width:100%;');
    });

    const title = $('title').text();
    const bodyHtml = $('body').html() || $.html();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Simplified: ${htmlEsc(title)}</title>
<style>body{font-family:sans-serif;padding:6px;max-width:400px;font-size:13px;}</style>
</head><body>
<p style="font-size:10px;background:#ffd;padding:3px;">
<a href="${proxyBase}/proxy?url=${encodeURIComponent(targetUrl)}">Full Page</a> | <a href="${proxyBase}/reader?url=${encodeURIComponent(targetUrl)}">Reader</a> | <a href="/">Home</a>
</p>
${bodyHtml}
</body></html>`);
  } catch (e) {
    res.send(`<html><body><p>Simplify error: ${htmlEsc(e.message)}</p><a href="/">Home</a></body></html>`);
  }
});

// ─── TRANSLATION ─────────────────────────────────────────────────────────────

app.get('/translate', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  const lang      = (req.query.lang || 'en').trim().toLowerCase();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!targetUrl) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Translate</title></head><body>
<h3>&#127760; Page Translation</h3>
<form method="GET" action="/translate">
URL: <input name="url" placeholder="https://..." style="width:70%;"><br>
Language: <select name="lang">
<option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option>
<option value="de">German</option><option value="it">Italian</option><option value="ja">Japanese</option>
<option value="zh">Chinese</option><option value="pt">Portuguese</option><option value="ru">Russian</option>
<option value="ar">Arabic</option><option value="ko">Korean</option>
</select><br>
<input type="submit" value="Translate">
</form><a href="/">Home</a></body></html>`);
  }

  try {
    const r = await proxyFetch(targetUrl);
    let html = r.data.toString('utf-8');

    const $ = cheerio.load(html, { decodeEntities: false });
    // Extract text nodes and translate them in batches
    const title = $('title').text();

    // Use LibreTranslate API if available, else link to Google Translate
    const ltKey = LIBRETRANSLATE_KEY;
    const ltUrl = LIBRETRANSLATE_URL;

    // Collect all text snippets
    const textNodes = [];
    $('p,h1,h2,h3,h4,li,td,th,span,div').each(function() {
      const t = $(this).clone().children('script,style').remove().end().text().trim();
      if (t.length > 5 && t.length < 1000) textNodes.push({ el: this, text: t });
    });

    // Translate a sample (first 20 nodes, to avoid timeout)
    const toTranslate = textNodes.slice(0, 20).map(n => n.text);

    let translated = [];
    try {
      const ltResp = await axios.post(`${ltUrl}/translate`, {
        q: toTranslate,
        source: 'auto',
        target: lang,
        api_key: ltKey || ''
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
      });
      if (ltResp.data && ltResp.data.translatedText) {
        translated = Array.isArray(ltResp.data.translatedText)
          ? ltResp.data.translatedText
          : [ltResp.data.translatedText];
      }
    } catch {}

    if (translated.length > 0) {
      textNodes.slice(0, translated.length).forEach((n, i) => {
        if (translated[i]) {
          try { $(n.el).prepend(`<span style="color:#080;font-size:11px;">[${lang.toUpperCase()}: ${htmlEsc(translated[i].substring(0,150))}]</span><br>`); } catch {}
        }
      });
      const out = transformHTML($.html(), targetUrl, proxyBase);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(out);
    }

    // Fallback: link to Google Translate version
    const gtUrl = `https://translate.google.com/translate?sl=auto&tl=${lang}&u=${encodeURIComponent(targetUrl)}`;
    return res.redirect(`/proxy?url=${encodeURIComponent(gtUrl)}`);

  } catch (e) {
    // Fallback: Google Translate
    const gtUrl = `https://translate.google.com/translate?sl=auto&tl=${lang}&u=${encodeURIComponent(targetUrl)}`;
    return res.redirect(`/proxy?url=${encodeURIComponent(gtUrl)}`);
  }
});

// ─── WEATHER ─────────────────────────────────────────────────────────────────

app.get('/weather', async (req, res) => {
  const q = (req.query.q || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!q) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>Weather</title></head><body>
<h3>&#9925; Weather</h3>
<form method="GET" action="/weather"><input name="q" placeholder="City name"><input type="submit" value="Get Weather"></form>
<a href="/">Home</a></body></html>`);
  }

  try {
    // wttr.in provides a simple JSON weather API, no key needed
    const wr = await axios.get(`https://wttr.in/${encodeURIComponent(q)}?format=j1`, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 10000,
      validateStatus: () => true
    });

    if (wr.status === 200 && wr.data.current_condition) {
      const c = wr.data.current_condition[0];
      const loc = wr.data.nearest_area[0];
      const city = (loc.areaName[0].value || '') + ', ' + (loc.country[0].value || '');
      const desc = c.weatherDesc[0].value;
      const temp_c = c.temp_C;
      const temp_f = c.temp_F;
      const humidity = c.humidity;
      const wind_kmph = c.windspeedKmph;
      const feels_c = c.FeelsLikeC;

      // 3-day forecast
      const forecast = (wr.data.weather || []).slice(0, 3).map(d => {
        return `<tr><td>${d.date}</td><td>${d.hourly[4] && d.hourly[4].weatherDesc[0].value || ''}</td><td>${d.mintempC}°C/${d.maxtempC}°C</td></tr>`;
      }).join('');

      return res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Weather: ${htmlEsc(city)}</title>
<style>body{font-family:sans-serif;padding:8px;max-width:400px;margin:0 auto;font-size:13px;}table{width:100%;border-collapse:collapse;}td,th{padding:3px;border:1px solid #ccc;font-size:12px;}</style>
</head><body>
<form method="GET" action="/weather"><input name="q" value="${htmlEsc(q)}" style="width:72%;font-size:12px;"><input type="submit" value="Search"></form>
<h3>&#9925; ${htmlEsc(city)}</h3>
<p><b>${htmlEsc(desc)}</b></p>
<table>
<tr><td>Temperature</td><td>${htmlEsc(temp_c)}°C / ${htmlEsc(temp_f)}°F</td></tr>
<tr><td>Feels Like</td><td>${htmlEsc(feels_c)}°C</td></tr>
<tr><td>Humidity</td><td>${htmlEsc(humidity)}%</td></tr>
<tr><td>Wind</td><td>${htmlEsc(wind_kmph)} km/h</td></tr>
</table>
<h4>3-Day Forecast</h4>
<table><tr><th>Date</th><th>Condition</th><th>Temp</th></tr>${forecast}</table>
<p><a href="${proxyBase}/proxy?url=${encodeURIComponent('https://wttr.in/'+encodeURIComponent(q))}">Full forecast</a></p>
<a href="/">Home</a>
</body></html>`);
    }
  } catch {}

  // Fallback: wttr.in plain text
  res.redirect(`/proxy?url=${encodeURIComponent('https://wttr.in/' + encodeURIComponent(q) + '?0&T')}`);
});

// ─── RSS / ATOM READER ───────────────────────────────────────────────────────

app.get('/rss', async (req, res) => {
  const feedUrl = (req.query.url || '').trim();
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!feedUrl) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>RSS Reader</title></head><body>
<h3>&#128240; RSS / Atom Reader</h3>
<form method="GET" action="/rss"><input name="url" placeholder="https://...feed.xml" style="width:70%;"><input type="submit" value="Read"></form>
<h4>Popular Feeds</h4>
<ul>
<li><a href="/rss?url=${encodeURIComponent('https://feeds.bbci.co.uk/news/rss.xml')}">BBC News</a></li>
<li><a href="/rss?url=${encodeURIComponent('https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml')}">NY Times</a></li>
<li><a href="/rss?url=${encodeURIComponent('https://www.reddit.com/r/technology/.rss')}">Reddit /r/technology</a></li>
<li><a href="/rss?url=${encodeURIComponent('https://hnrss.org/frontpage')}">Hacker News</a></li>
<li><a href="/rss?url=${encodeURIComponent('https://www.theverge.com/rss/index.xml')}">The Verge</a></li>
<li><a href="/rss?url=${encodeURIComponent('https://feeds.feedburner.com/TechCrunch')}">TechCrunch</a></li>
</ul>
<a href="/">Home</a></body></html>`);
  }

  try {
    const r = await axios.get(feedUrl, {
      headers: { 'User-Agent': MODERN_UA, Accept: 'application/rss+xml,application/xml,text/xml,*/*' },
      timeout: 12000,
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
    const xml = r.data.toString('utf-8');
    const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: true });

    const feedTitle = $('channel > title').first().text() || $('feed > title').first().text() || feedUrl;
    const items = [];

    // RSS
    $('item').each(function() {
      items.push({
        title   : $(this).find('title').first().text(),
        link    : $(this).find('link').first().text() || $(this).find('link').first().attr('href'),
        desc    : $(this).find('description').first().text().replace(/<[^>]+>/g,'').substring(0,200),
        date    : $(this).find('pubDate').first().text() || $(this).find('dc\\:date').first().text()
      });
    });

    // Atom
    if (items.length === 0) {
      $('entry').each(function() {
        items.push({
          title : $(this).find('title').first().text(),
          link  : $(this).find('link[rel="alternate"]').attr('href') || $(this).find('link').first().attr('href'),
          desc  : $(this).find('summary').first().text().replace(/<[^>]+>/g,'').substring(0,200) ||
                  $(this).find('content').first().text().replace(/<[^>]+>/g,'').substring(0,200),
          date  : $(this).find('updated').first().text() || $(this).find('published').first().text()
        });
      });
    }

    let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>RSS: ${htmlEsc(feedTitle)}</title>
<style>
body{font-family:sans-serif;padding:6px;max-width:400px;margin:0 auto;font-size:13px;}
.item{margin-bottom:8px;padding:5px;background:#fff;border:1px solid #ccc;}
.item a{color:#00c;font-weight:bold;}
.item small{color:#666;font-size:10px;}
.item p{margin:2px 0;font-size:11px;color:#333;}
</style>
</head><body>
<h3>&#128240; ${htmlEsc(feedTitle)}</h3>
<p style="font-size:11px;">${items.length} items | <a href="/rss?url=${encodeURIComponent(feedUrl)}">Refresh</a> | <a href="/rss">All Feeds</a> | <a href="/">Home</a></p>`;

    items.slice(0, 30).forEach(item => {
      const link = item.link ? `${proxyBase}/proxy?url=${encodeURIComponent(item.link)}` : '#';
      const readerLink = item.link ? `${proxyBase}/reader?url=${encodeURIComponent(item.link)}` : '#';
      html += `<div class="item">
<a href="${link}">${htmlEsc(item.title || '(no title)')}</a>
<small>${htmlEsc(item.date||'').substring(0,30)}</small>
${item.desc ? `<p>${htmlEsc(item.desc)}</p>` : ''}
<small><a href="${readerLink}">Reader mode</a></small>
</div>`;
    });

    html += `<a href="/">&#8962; Home</a></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    res.send(`<html><body><p>RSS error: ${htmlEsc(e.message)}</p><a href="/">Home</a></body></html>`);
  }
});

// ─── BOOKMARKS ───────────────────────────────────────────────────────────────

app.get('/bookmarks', (req, res) => {
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const sess = getSession(req, res);

  let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Bookmarks</title>
<style>body{font-family:sans-serif;padding:6px;max-width:400px;font-size:13px;}.bk{padding:4px;border-bottom:1px solid #ddd;}</style>
</head><body>
<h3>&#9733; Bookmarks</h3>
<a href="/">Home</a> | <a href="/history">History</a>
<p style="font-size:11px;">${sess.bookmarks.length} bookmarks</p>`;

  if (sess.bookmarks.length === 0) {
    html += `<p>No bookmarks yet. Browse a page and tap "+ Bookmark" in the toolbar.</p>`;
  } else {
    sess.bookmarks.forEach((b, i) => {
      html += `<div class="bk">
<a href="${proxyBase}/proxy?url=${encodeURIComponent(b.url)}">${htmlEsc(b.title || b.url).substring(0,60)}</a>
<small style="display:block;color:#666;font-size:10px;">${htmlEsc(b.url).substring(0,50)}</small>
<small><a href="${proxyBase}/del-bookmark?i=${i}" style="color:#c00;">Remove</a></small>
</div>`;
    });
  }

  // Import/export as text
  html += `<hr><h4>Add bookmark manually</h4>
<form method="GET" action="/add-bookmark">
URL: <input name="url" placeholder="https://..." style="width:70%;font-size:11px;"><br>
Title: <input name="title" placeholder="Page title" style="width:70%;font-size:11px;"><br>
<input type="submit" value="Add">
</form>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/add-bookmark', (req, res) => {
  const url   = (req.query.url || '').trim();
  const title = (req.query.title || url).trim();
  const sess  = getSession(req, res);

  if (url && sess.bookmarks.length < MAX_BOOK) {
    const exists = sess.bookmarks.some(b => b.url === url);
    if (!exists) sess.bookmarks.unshift({ url, title, ts: Date.now() });
  }
  res.redirect('/bookmarks');
});

app.get('/del-bookmark', (req, res) => {
  const i    = parseInt(req.query.i || '-1');
  const sess = getSession(req, res);
  if (i >= 0 && i < sess.bookmarks.length) sess.bookmarks.splice(i, 1);
  res.redirect('/bookmarks');
});

// ─── HISTORY ─────────────────────────────────────────────────────────────────

app.get('/history', (req, res) => {
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const sess = getSession(req, res);

  let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>History</title>
<style>body{font-family:sans-serif;padding:6px;max-width:400px;font-size:13px;}.hi{padding:3px;border-bottom:1px solid #eee;font-size:12px;}</style>
</head><body>
<h3>&#128221; Browsing History</h3>
<a href="/">Home</a> | <a href="/bookmarks">Bookmarks</a> | <a href="/clear-history">Clear History</a>
<p style="font-size:11px;">${sess.history.length} entries</p>`;

  if (sess.history.length === 0) {
    html += `<p>No history yet.</p>`;
  } else {
    sess.history.forEach((h, i) => {
      const d = new Date(h.ts);
      const ts = `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      html += `<div class="hi">
<a href="${proxyBase}/proxy?url=${encodeURIComponent(h.url)}">${htmlEsc((h.title||h.url).substring(0,50))}</a>
<span style="color:#999;font-size:10px;float:right;">${ts}</span>
</div>`;
    });
  }

  html += `</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/clear-history', (req, res) => {
  const sess = getSession(req, res);
  sess.history = [];
  res.redirect('/history');
});

// ─── HELP PAGE ───────────────────────────────────────────────────────────────

app.get('/help', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Help – 3DS Proxy</title>
<style>body{font-family:sans-serif;padding:8px;max-width:400px;font-size:12px;}h3{color:#224;font-size:14px;}dt{font-weight:bold;color:#224;}dd{margin:0 0 6px 8px;}</style>
</head><body>
<h3>&#10067; 3DS Mega Proxy Help</h3>
<dl>
<dt>Search</dt><dd>Type anything in the box. Uses DuckDuckGo Lite. Prefix with <b>wiki:</b>, <b>img:</b>, or <b>weather:</b> for quick access.</dd>
<dt>Reader Mode</dt><dd>Strips ads and clutter from any article. Tap the "Reader" link in the top bar.</dd>
<dt>Simplify</dt><dd>Removes all CSS/JS and shows plain text + links. Good for heavy sites.</dd>
<dt>Translate</dt><dd>Translates any page via LibreTranslate (or falls back to Google Translate).</dd>
<dt>Bookmarks</dt><dd>Saved per browser session (30-day cookie). Tap "+ Bookmark" in any proxied page toolbar.</dd>
<dt>History</dt><dd>Last 50 pages visited. Auto-clears when cookie expires.</dd>
<dt>RSS Reader</dt><dd>Reads RSS and Atom feeds. Works with most news sites.</dd>
<dt>Image Search</dt><dd>DuckDuckGo image search, shows thumbnails.</dd>
<dt>Weather</dt><dd>Uses wttr.in – no API key needed. Shows 3-day forecast.</dd>
<dt>Wikipedia</dt><dd>Article summaries via Wikipedia REST API. Search works too.</dd>
<dt>Site Rewrites</dt><dd>reddit.com → old.reddit.com, twitter.com → nitter.net, medium.com → scribe.rip</dd>
<dt>YouTube</dt><dd>Embeds replaced with thumbnail + link. Can still browse YouTube pages.</dd>
<dt>Cache</dt><dd>Pages cached 5 minutes server-side. Add ?nocache=1 to bypass.</dd>
<dt>Forms</dt><dd>GET and POST forms both work, including login forms.</dd>
<dt>Cookies</dt><dd>Site cookies forwarded so logged-in sessions are maintained per domain.</dd>
</dl>
<a href="/">&#8962; Home</a>
</body></html>`);
});

// ─── /ask alias ──────────────────────────────────────────────────────────────

app.get('/ask', (req, res) => {
  res.redirect(`/search?q=${encodeURIComponent(req.query.q || req.query.query || '')}`);
});

// ─── FORM GET HANDLER ────────────────────────────────────────────────────────

app.get('/form-get', async (req, res) => {
  const targetUrl = req.query.__proxy_url;
  if (!targetUrl) return res.redirect('/');
  const params = { ...req.query };
  delete params.__proxy_url;
  try {
    const u = new urlModule.URL(targetUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return res.redirect(`/proxy?url=${encodeURIComponent(u.href)}`);
  } catch {
    const qs = new urlModule.URLSearchParams(params).toString();
    const sep = targetUrl.includes('?') ? '&' : '?';
    return res.redirect(`/proxy?url=${encodeURIComponent(targetUrl + (qs ? sep + qs : ''))}`);
  }
});

// ─── FORM POST HANDLER ───────────────────────────────────────────────────────

app.all('/form-post', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const host = new urlModule.URL(targetUrl).hostname;
    const response = await proxyFetch(targetUrl, {
      method: req.method,
      data: new urlModule.URLSearchParams(req.body).toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookiesFor(host)
      }
    });
    storeCookies(host, response.headers['set-cookie']);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      return res.redirect(`/proxy?url=${encodeURIComponent(resolveUrl(targetUrl, response.headers.location))}`);
    }
    const html = response.data.toString('utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(transformHTML(html, targetUrl, proxyBase));
  } catch (e) {
    res.send(`<html><body><p>Form error: ${htmlEsc(e.message)}</p><a href="javascript:history.back()">Back</a></body></html>`);
  }
});

// ─── CSS ENDPOINT ────────────────────────────────────────────────────────────

app.get('/css', async (req, res) => {
  const targetUrl = req.query.url;
  const baseUrl   = req.query.base || targetUrl;
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  if (!targetUrl) return res.send('');
  const cached = cacheGet('css:' + targetUrl);
  if (cached) { res.setHeader('Content-Type', 'text/css; charset=utf-8'); return res.send(cached.data); }
  try {
    const r = await axios.get(targetUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 12000, validateStatus: () => true });
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    const out = transformCSS(r.data.toString('utf-8'), baseUrl, proxyBase);
    cacheSet('css:' + targetUrl, out, 'text/css; charset=utf-8');
    res.send(out);
  } catch { res.send('/* css fetch failed */'); }
});

// ─── JS ENDPOINT ─────────────────────────────────────────────────────────────

app.get('/js', async (req, res) => {
  const targetUrl = req.query.url;
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  if (!targetUrl) return res.send('');
  try {
    const r = await axios.get(targetUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 12000, validateStatus: () => true });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(transformJS(r.data.toString('utf-8'), proxyBase, targetUrl));
  } catch { res.send('/* js fetch failed */'); }
});

// ─── RESOURCE ENDPOINT ───────────────────────────────────────────────────────

app.get('/resource', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.end();
  try {
    const r = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': MODERN_UA },
      timeout: 20000,
      validateStatus: () => true
    });
    const ct = r.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(r.data);
  } catch { res.end(); }
});

// ─── CACHE CLEAR ─────────────────────────────────────────────────────────────

app.get('/cache-clear', (req, res) => {
  PAGE_CACHE.clear();
  res.send(`<html><body><p>Cache cleared.</p><a href="/">Home</a></body></html>`);
});

// ─── CATCH-ALL ───────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const referer  = req.headers.referer || '';
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const match    = referer.match(/[?&]url=([^&]+)/);
  if (match) {
    try {
      const originUrl = decodeURIComponent(match[1]);
      const origin    = new urlModule.URL(originUrl);
      const targetUrl = `${origin.protocol}//${origin.host}${req.url}`;
      return res.redirect(`/proxy?url=${encodeURIComponent(targetUrl)}`);
    } catch {}
  }
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><body>
<h3>404 – Not found</h3>
<p>Path: <code>${htmlEsc(req.url)}</code></p>
<a href="/">&#8962; Home</a>
</body></html>`);
});

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`3DS Mega Proxy v3.0 running on port ${PORT}`);
  console.log(`  Home:      http://localhost:${PORT}/`);
  console.log(`  Search:    http://localhost:${PORT}/search?q=...`);
  console.log(`  Reader:    http://localhost:${PORT}/reader?url=...`);
  console.log(`  Translate: http://localhost:${PORT}/translate?url=...&lang=es`);
  console.log(`  Weather:   http://localhost:${PORT}/weather?q=New+York`);
  console.log(`  RSS:       http://localhost:${PORT}/rss?url=...`);
  console.log(`  Wiki:      http://localhost:${PORT}/wiki?q=...`);
  console.log(`  Images:    http://localhost:${PORT}/images?q=...`);
});
