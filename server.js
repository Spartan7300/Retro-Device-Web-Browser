'use strict';

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  3DS NEGATIVE-PASSTHROUGH PROXY  —  server.js                              ║
// ║  Everything passes through. Modern → Legacy conversions happen in-flight.  ║
// ║  Strategy: NEVER block; ALWAYS try to convert; remove only as last resort. ║
// ║                                                                              ║
// ║  Handles:                                                                   ║
// ║  • HTML  : full DOM rewrite, video/media, iframes, SVG, canvas fallbacks   ║
// ║  • CSS   : v3→v2.3, variables, grid, flexbox, custom properties, filters   ║
// ║  • JS    : ES6+→ES5, modules, async/await, destructuring, class sugar       ║
// ║  • Video : YouTube, Vimeo, Dailymotion, HLS/DASH→MP4, direct streams       ║
// ║  • Images: WebP/AVIF→JPEG, srcset collapse, lazy-load resolution           ║
// ║  • Fonts : WOFF2→WOFF/TTF fallback chain                                   ║
// ║  • Audio : modern codec → MP3 redirect                                      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const css       = require('css');
const urlModule = require('url');
const http      = require('http');
const https     = require('https');
const zlib      = require('zlib');
const stream    = require('stream');

// ── Optional: ytdl-core for YouTube ──────────────────────────────────────────
let ytdl = null;
try { ytdl = require('ytdl-core'); } catch(e) {
  console.warn('[proxy] ytdl-core not installed — YouTube download disabled');
}

// ── Optional: fluent-ffmpeg + ffmpeg-static for on-the-fly transcoding ───────
let ffmpeg = null, ffmpegPath = null;
try {
  ffmpeg     = require('fluent-ffmpeg');
  ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('[proxy] ffmpeg available — on-the-fly video transcode enabled');
} catch(e) {
  console.warn('[proxy] fluent-ffmpeg / ffmpeg-static not installed — transcoding disabled');
}

// ── Optional: sharp for WebP→JPEG image conversion ───────────────────────────
let sharp = null;
try {
  sharp = require('sharp');
  console.log('[proxy] sharp available — WebP/AVIF→JPEG conversion enabled');
} catch(e) {
  console.warn('[proxy] sharp not installed — image conversion disabled');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── TUNEABLE CONSTANTS ────────────────────────────────────────────────────────
const TIMEOUT_MS          = 20000;   // upstream fetch timeout
const VIDEO_TIMEOUT_MS    = 60000;   // longer for video fetches
const MAX_BODY_MB         = 20;      // max response body to buffer (MB)
const MAX_CSS_BYTES       = 800000;  // CSS files larger than this get truncated
const MAX_JS_BYTES        = 1200000; // JS files larger than this skip transform
const IMAGE_QUALITY       = 75;      // JPEG quality for converted images
const VIDEO_MAX_HEIGHT    = 240;     // target video height (pixels) for 3DS

// ─── USER AGENTS ──────────────────────────────────────────────────────────────
const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/90.0.4430.91 Mobile Safari/537.36';

// ═══════════════════════════════════════════════════════════════════════════════
// §1  URL UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function resolveUrl(base, relative) {
  try {
    if (!relative) return base;
    relative = relative.trim();
    if (relative.startsWith('data:') || relative.startsWith('javascript:') ||
        relative.startsWith('mailto:') || relative.startsWith('tel:')) return relative;
    if (relative.startsWith('//')) {
      const b = new urlModule.URL(base);
      return b.protocol + relative;
    }
    return new urlModule.URL(relative, base).href;
  } catch { return relative || base; }
}

function proxyUrl(abs, proxyBase) {
  return proxyBase + '/proxy?url=' + encodeURIComponent(abs);
}

function isVideoUrl(url) {
  return /\.(mp4|webm|ogv|ogg|mov|avi|mkv|flv|m4v|3gp|ts|m2ts)(\?|$)/i.test(url);
}

function isAudioUrl(url) {
  return /\.(mp3|ogg|oga|wav|flac|aac|opus|m4a|webm)(\?|$)/i.test(url);
}

function isImageUrl(url) {
  return /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)(\?|$)/i.test(url);
}

function isModernImageFormat(ct) {
  return /webp|avif|image\/jxl/i.test(ct);
}

// ═══════════════════════════════════════════════════════════════════════════════
// §2  SEARCH ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchSearch(q) {
  // Try DDG Lite first
  try {
    const r = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q },
      headers: { 'User-Agent': MODERN_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.5' },
      timeout: 10000, validateStatus: () => true
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('a.result-link').each(function () {
      const href  = $(this).attr('href') || '';
      const title = $(this).text().trim();
      let realUrl = href;
      try {
        const u = new urlModule.URL('https://lite.duckduckgo.com' + href);
        realUrl  = u.searchParams.get('uddg') || href;
      } catch { try { realUrl = new urlModule.URL(href).href; } catch {} }
      if (realUrl && title) results.push({ url: realUrl, title, content: '' });
    });
    $('td.result-snippet').each(function (i) {
      if (results[i]) results[i].content = $(this).text().trim();
    });
    if (results.length) return { results };
  } catch {}

  // SearX fallback instances
  for (const inst of [
    'https://searx.be', 'https://searx.tiekoetter.com',
    'https://search.bus-hit.me', 'https://paulgo.io'
  ]) {
    try {
      const r = await axios.get(inst + '/search', {
        params: { q, format: 'json' },
        headers: { 'User-Agent': MODERN_UA },
        timeout: 7000
      });
      if (r.data && r.data.results && r.data.results.length) return r.data;
    } catch {}
  }
  throw new Error('All search providers failed');
}

// ═══════════════════════════════════════════════════════════════════════════════
// §3  UPSTREAM FETCH WITH DECOMPRESSION
// ═══════════════════════════════════════════════════════════════════════════════

async function proxyFetch(targetUrl, options = {}) {
  return await axios({
    url: targetUrl,
    method: options.method || 'GET',
    headers: {
      'User-Agent':      options.mobile ? MOBILE_UA : MODERN_UA,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      ...(options.headers || {})
    },
    data:         options.data,
    params:       options.params,
    responseType: 'arraybuffer',
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: options.timeout || TIMEOUT_MS,
    decompress: true,
    maxContentLength: MAX_BODY_MB * 1024 * 1024,
    maxBodyLength:    MAX_BODY_MB * 1024 * 1024,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §4  CSS VARIABLE EXTRACTION & RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

function extractCSSVars(rawCss) {
  const vars = {};
  const rootBlocks = rawCss.match(/(?::root|html)\s*\{([^}]*)\}/gi) || [];
  for (const block of rootBlocks) {
    const inner = block.replace(/^[^{]+\{/, '').replace(/\}$/, '');
    const decls = inner.match(/--[\w-]+\s*:[^;]+/g) || [];
    for (const d of decls) {
      const colon = d.indexOf(':');
      vars[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
    }
  }
  return vars;
}

function resolveVar(name, vars, depth) {
  if (depth > 8) return '';
  const val = vars[name];
  if (!val) return '';
  return val.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (m, n, fb) => {
    const r = resolveVar(n, vars, depth + 1);
    return r || (fb ? fb.trim() : '');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// §5  CSS VALUE DOWNGRADER  (CSS3 → CSS2.3-compatible)
// ═══════════════════════════════════════════════════════════════════════════════

function downgradeCSSValue(prop, value, vars) {
  if (!value) return value;

  // ── CSS custom properties (var()) ─────────────────────────────────────────
  value = value.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)/gi, (m, name, fb) => {
    const resolved = resolveVar(name, vars || {}, 0);
    if (resolved) return resolved;
    if (fb) return fb.trim();
    if (/color|background/.test(prop)) return 'transparent';
    if (/width|height|size|radius|gap|padding|margin|border/.test(prop)) return '0';
    return 'inherit';
  });

  // ── Color space modernisms ─────────────────────────────────────────────────
  // Space-separated rgba(r g b / a)
  value = value.replace(/rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*[\d.%]+)?\s*\)/gi,
    (m, r, g, b) => 'rgb(' + r + ',' + g + ',' + b + ')');
  // rgba(r,g,b,a) → rgb(r,g,b)
  value = value.replace(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,[^)]+\)/gi,
    (m, r, g, b) => 'rgb(' + r + ',' + g + ',' + b + ')');
  // Space-separated hsl(h s% l% / a)
  value = value.replace(/hsla?\(\s*([\d.]+(?:deg|grad|rad|turn)?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*[\d.%]+)?\s*\)/gi,
    (m, h, s, l) => 'hsl(' + h.replace(/deg|rad|grad|turn/, '') + ',' + s + ',' + l + ')');
  // hsla(h,s,l,a) → hsl(h,s,l)
  value = value.replace(/hsla\(([^,]+,[^,]+,[^,]+),[^)]+\)/gi,
    (m, inner) => 'hsl(' + inner + ')');
  // oklch/lab/lch/display-p3 → safe gray
  value = value.replace(/\b(?:ok)?(?:lch|lab|color)\([^)]+\)/gi, '#888888');
  // light-dark() → first arg (light mode)
  value = value.replace(/light-dark\(\s*([^,)]+),[^)]+\)/gi, (m, a) => a.trim());
  // color-mix() → first color
  value = value.replace(/color-mix\([^,]+,\s*([^,)]+)(?:,[^)]*)?\)/gi, (m, c) => c.trim().replace(/\s+\d+%$/, ''));

  // ── Math functions ─────────────────────────────────────────────────────────
  value = value.replace(/calc\(([^)]+)\)/gi, (m, expr) => {
    try {
      const su = expr.match(/^([\d.]+)(px|em|rem|%)\s*([+\-])\s*([\d.]+)\2$/);
      if (su) { const v = su[3] === '+' ? +su[1] + +su[4] : +su[1] - +su[4]; return Math.max(0, v) + su[2]; }
      const pn = expr.match(/^([\d.]+)\s*([+\-\*\/])\s*([\d.]+)$/);
      if (pn) { const a = +pn[1], op = pn[2], b = +pn[3];
        return String(op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:b?+(a/b).toFixed(4):a); }
      if (/^100%\s*-\s*[\d.]+px$/.test(expr)) return '95%';
      if (/width|height|size/.test(prop)) return '100%';
    } catch {}
    return 'auto';
  });
  // clamp(min,val,max) → val
  value = value.replace(/clamp\(\s*[^,]+,\s*([^,]+),\s*[^)]+\)/gi, (m, v) => v.trim());
  // min(a,b) → a
  value = value.replace(/\bmin\(\s*([^,)]+),[^)]+\)/gi, (m, a) => a.trim());
  // max(a,b) → b
  value = value.replace(/\bmax\([^,]+,\s*([^)]+)\)/gi, (m, b) => b.trim());

  // ── Gradients — extract first color stop ──────────────────────────────────
  value = value.replace(/(?:linear|radial|conic)-gradient\s*\(/gi, '__GRAD__(');
  value = value.replace(/__GRAD__\(([^]*?)\)/g, (m, inner) => {
    const colRe = /(#[\da-fA-F]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|hsl\(\s*[\d.]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+\s*\)|[a-zA-Z]{3,20})/g;
    const skip  = /^(to|from|at|circle|ellipse|closest|farthest|cover|contain|top|bottom|left|right|center|transparent|none|deg|grad|rad|turn|px|em|rem|vh|vw)$/i;
    const stops = []; let cm;
    while ((cm = colRe.exec(inner)) !== null)
      if (!skip.test(cm[1]) && !/^\d/.test(cm[1])) stops.push(cm[1]);
    return stops.length ? stops[0] : '#cccccc';
  });

  // ── Viewport/environment units ─────────────────────────────────────────────
  value = value.replace(/\b([\d.]+)dvw\b/gi, (m, n) => n + 'vw');
  value = value.replace(/\b([\d.]+)dvh\b/gi, (m, n) => n + 'vh');
  value = value.replace(/\b([\d.]+)svw\b/gi, (m, n) => n + 'vw');
  value = value.replace(/\b([\d.]+)svh\b/gi, (m, n) => n + 'vh');
  value = value.replace(/\b([\d.]+)lvw\b/gi, (m, n) => n + 'vw');
  value = value.replace(/\b([\d.]+)lvh\b/gi, (m, n) => n + 'vh');
  value = value.replace(/\b([\d.]+)cqi\b/gi, (m, n) => n + '%');
  value = value.replace(/\b([\d.]+)cqb\b/gi, (m, n) => n + '%');
  // vw/vh → % where it makes sense in dimensional props
  if (/width|height|size|padding|margin|gap/.test(prop)) {
    value = value.replace(/\b([\d.]+)vw\b/gi, (m, n) => Math.min(+n, 100) + '%');
    value = value.replace(/\b([\d.]+)vh\b/gi, (m, n) => n + 'px');
  }
  // rem → px (assume 16px base)
  value = value.replace(/\b([\d.]+)rem\b/gi, (m, n) => Math.round(+n * 16) + 'px');

  // ── CSS functions that don't exist on old WebKit ───────────────────────────
  value = value.replace(/env\(\s*[\w-]+(?:\s*,\s*([^)]+))?\)/gi, (m, fb) => fb ? fb.trim() : '0');
  value = value.replace(/fit-content\([^)]*\)/gi, 'auto');
  value = value.replace(/\b(?:min|max)-content\b/gi, 'auto');
  value = value.replace(/\bstretch\b/g, '100%');
  value = value.replace(/\bfit-content\b/g, 'auto');

  // ── Easing functions ───────────────────────────────────────────────────────
  value = value.replace(/\blinear\(([^)]+)\)/gi, 'ease');
  value = value.replace(/\bsteps\(\s*(\d+)\s*,\s*jump-\w+\s*\)/gi, (m, n) => 'steps(' + n + ',end)');

  return value;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §6  CSS PROPERTY DOWNGRADER
// ═══════════════════════════════════════════════════════════════════════════════

function downgradeCSSProperty(decl, vars) {
  const prop   = (decl.property || '').toLowerCase().trim();
  const rawVal = decl.value || '';
  let val      = downgradeCSSValue(prop, rawVal, vars);

  // ── display ──────────────────────────────────────────────────────────────
  if (prop === 'display') {
    if (/\bgrid\b|\binline-grid\b/.test(val))
      return [{ type:'declaration', property:'display', value:'block' }];
    if (val === 'flex' || val === 'inline-flex') {
      return [
        { type:'declaration', property:'display', value:'-webkit-box' },
        { type:'declaration', property:'display', value:'-webkit-flex' },
        { type:'declaration', property:'display', value: val }
      ];
    }
    if (val === 'contents')
      return [{ type:'declaration', property:'display', value:'block' }];
    if (val === 'flow-root' || val === 'run-in')
      return [{ type:'declaration', property:'display', value:'block' }];
    if (val === 'inline-block' || val === 'inline') { decl.value = val; return [decl]; }
    decl.value = val; return [decl];
  }

  // ── flexbox full suite ────────────────────────────────────────────────────
  if (prop === 'flex-direction') {
    const isCol = val.includes('column'), isRev = val.includes('reverse');
    return [
      { type:'declaration', property:'-webkit-box-orient',    value: isCol ? 'vertical' : 'horizontal' },
      { type:'declaration', property:'-webkit-box-direction', value: isRev ? 'reverse' : 'normal' },
      { type:'declaration', property:'-webkit-flex-direction',value: val },
      { type:'declaration', property:'flex-direction',        value: val }
    ];
  }
  if (prop === 'flex-wrap')
    return [
      { type:'declaration', property:'-webkit-flex-wrap', value: val },
      { type:'declaration', property:'flex-wrap',         value: val }
    ];
  if (prop === 'align-items') {
    const wk = { center:'center','flex-start':'start','flex-end':'end',stretch:'stretch',baseline:'baseline' };
    return [
      { type:'declaration', property:'-webkit-box-align',   value: wk[val] || val },
      { type:'declaration', property:'-webkit-align-items', value: val },
      { type:'declaration', property:'align-items',         value: val }
    ];
  }
  if (prop === 'align-content')
    return [
      { type:'declaration', property:'-webkit-align-content', value: val },
      { type:'declaration', property:'align-content',         value: val }
    ];
  if (prop === 'align-self')
    return [
      { type:'declaration', property:'-webkit-align-self', value: val },
      { type:'declaration', property:'align-self',         value: val }
    ];
  if (prop === 'justify-content') {
    const wk = { center:'center','flex-start':'start','flex-end':'end',
      'space-between':'justify','space-around':'justify','space-evenly':'justify' };
    return [
      { type:'declaration', property:'-webkit-box-pack',       value: wk[val] || val },
      { type:'declaration', property:'-webkit-justify-content',value: val },
      { type:'declaration', property:'justify-content',        value: val }
    ];
  }
  if (prop === 'justify-items' || prop === 'justify-self') return [];
  if (prop === 'flex' || prop === 'flex-grow') {
    const fn = parseFloat(val) || 1;
    return [
      { type:'declaration', property:'-webkit-box-flex', value: String(fn) },
      { type:'declaration', property:'-webkit-flex',     value: val },
      { type:'declaration', property:prop,               value: val }
    ];
  }
  if (prop === 'flex-shrink')
    return [
      { type:'declaration', property:'-webkit-flex-shrink', value: val },
      { type:'declaration', property:'flex-shrink',         value: val }
    ];
  if (prop === 'flex-basis')
    return [
      { type:'declaration', property:'-webkit-flex-basis', value: val },
      { type:'declaration', property:'flex-basis',         value: val }
    ];
  if (prop === 'flex-flow')
    return [
      { type:'declaration', property:'-webkit-flex-flow', value: val },
      { type:'declaration', property:'flex-flow',         value: val }
    ];
  if (prop === 'order') {
    const n = parseInt(val) || 0;
    return [
      { type:'declaration', property:'-webkit-box-ordinal-group', value: String(n + 1) },
      { type:'declaration', property:'-webkit-order', value: val },
      { type:'declaration', property:'order',         value: val }
    ];
  }
  if (prop === 'place-items') {
    const parts = val.split(/\s+/);
    const ai = parts[0], ji = parts[1] || parts[0];
    return [
      { type:'declaration', property:'align-items', value: ai },
      { type:'declaration', property:'-webkit-align-items', value: ai },
    ];
  }
  if (prop === 'place-content') {
    const parts = val.split(/\s+/);
    return [
      { type:'declaration', property:'align-content', value: parts[0] },
      { type:'declaration', property:'justify-content', value: parts[1] || parts[0] },
    ];
  }

  // ── gap → margin approximation ────────────────────────────────────────────
  if (prop === 'gap' || prop === 'grid-gap') {
    const gparts = val.trim().split(/\s+/);
    const gRow = gparts[0], gCol = gparts[1] || gparts[0];
    return [
      { type:'declaration', property:'margin-bottom', value: gRow },
      { type:'declaration', property:'margin-right',  value: gCol }
    ];
  }
  if (prop === 'column-gap' || prop === 'grid-column-gap')
    return [{ type:'declaration', property:'margin-right', value: val }];
  if (prop === 'row-gap' || prop === 'grid-row-gap')
    return [{ type:'declaration', property:'margin-bottom', value: val }];

  // ── CSS Grid — convert to block layout ───────────────────────────────────
  if (prop === 'grid-template-columns') {
    // Try to detect column count and set a percentage width on children
    const colCount = (val.match(/(?:,|\s+)/g) || []).length + 1;
    const colW = Math.floor(100 / Math.max(1, colCount)) + '%';
    return [
      { type:'declaration', property:'display', value:'block' },
      { type:'declaration', property:'width',   value:'100%' }
    ];
  }
  if (prop === 'grid-template-rows')
    return [{ type:'declaration', property:'height', value:'auto' }];
  if (prop.startsWith('grid-template') || prop.startsWith('grid-auto') ||
      prop === 'grid-area' || prop === 'grid-column' || prop === 'grid-row' ||
      prop === 'grid' || prop === 'grid-column-start' || prop === 'grid-column-end' ||
      prop === 'grid-row-start' || prop === 'grid-row-end' || prop === 'grid-placement')
    return [];

  // ── position:sticky ───────────────────────────────────────────────────────
  if (prop === 'position' && val === 'sticky')
    return [
      { type:'declaration', property:'position', value:'-webkit-sticky' },
      { type:'declaration', property:'position', value:'sticky' }
    ];
  // position: fixed → absolute (3DS viewport issues with fixed)
  if (prop === 'position' && val === 'fixed')
    return [{ type:'declaration', property:'position', value:'absolute' }];

  // ── overflow ──────────────────────────────────────────────────────────────
  if (prop === 'overflow' && val === 'overlay')
    return [{ type:'declaration', property:'overflow', value:'auto' }];
  if ((prop === 'overflow-x' || prop === 'overflow-y') && val === 'clip')
    return [{ type:'declaration', property:prop, value:'hidden' }];

  // ── text-decoration shorthand → keyword only ──────────────────────────────
  if (prop === 'text-decoration') {
    const tokens = val.split(/\s+/);
    for (const t of tokens)
      if (['underline','overline','line-through','none'].includes(t))
        return [{ type:'declaration', property:'text-decoration', value: t }];
  }

  // ── background — strip unsupported multi-layer syntax ─────────────────────
  if (prop === 'background' || prop === 'background-image') {
    if (val.indexOf(',') !== -1 && !val.startsWith('url(') && !/^(#|rgb|hsl)/.test(val))
      val = val.split(',')[0].trim();
    decl.value = val; return [decl];
  }

  // ── background-clip: text → remove (no WebKit prefix fallback on 3DS) ─────
  if (prop === 'background-clip' && val === 'text') return [];
  if (prop === '-webkit-background-clip' && val === 'text')
    return [{ type:'declaration', property:'-webkit-background-clip', value: val }];
  if (prop === '-webkit-text-fill-color') return [];

  // ── font properties ───────────────────────────────────────────────────────
  if (['font-feature-settings','font-variation-settings','font-optical-sizing',
       'font-kerning','font-display','font-synthesis','font-language-override'].includes(prop))
    return [];

  // ── aspect-ratio → compute explicit height if width known ─────────────────
  if (prop === 'aspect-ratio') {
    // We can't compute height without width, so just set padding-bottom hack
    const parts = val.split('/').map(s => parseFloat(s.trim()) || 1);
    const pct   = ((parts[1] / parts[0]) * 100).toFixed(2) + '%';
    return [{ type:'declaration', property:'padding-bottom', value: pct }];
  }

  // ── object-fit → basic width/height ──────────────────────────────────────
  if (prop === 'object-fit') {
    if (val === 'cover' || val === 'fill')
      return [
        { type:'declaration', property:'width',  value:'100%' },
        { type:'declaration', property:'height',  value:'auto' }
      ];
    return [
      { type:'declaration', property:'max-width',  value:'100%' },
      { type:'declaration', property:'height', value:'auto' }
    ];
  }
  if (prop === 'object-position') return [];

  // ── webkit-prefixed pairs ─────────────────────────────────────────────────
  const wkPairs = [
    'border-radius','border-top-left-radius','border-top-right-radius',
    'border-bottom-left-radius','border-bottom-right-radius',
    'box-shadow','box-sizing',
    'transform','transform-origin','transform-style',
    'perspective','perspective-origin',
    'transition','transition-property','transition-duration',
    'transition-timing-function','transition-delay',
    'animation','animation-name','animation-duration','animation-timing-function',
    'animation-iteration-count','animation-fill-mode','animation-direction',
    'animation-play-state','animation-delay',
    'appearance','user-select','backface-visibility','filter',
    'columns','column-count','column-rule','column-span','column-width',
    'text-size-adjust','tap-highlight-color','overflow-scrolling','font-smoothing',
    'hyphens','line-clamp','box-decoration-break',
    'text-stroke','text-stroke-width','text-stroke-color',
  ];
  if (wkPairs.includes(prop)) {
    const out = [{ type:'declaration', property:'-webkit-' + prop, value: val }];
    if (['appearance','user-select','columns','column-count','column-rule','hyphens'].includes(prop))
      out.push({ type:'declaration', property:'-moz-' + prop, value: val });
    out.push({ type:'declaration', property:prop, value: val });
    return out;
  }

  // ── Logical properties → physical ─────────────────────────────────────────
  const logicalMap = {
    'margin-inline':        ['margin-left', 'margin-right'],
    'margin-block':         ['margin-top',  'margin-bottom'],
    'margin-inline-start':  ['margin-left'],
    'margin-inline-end':    ['margin-right'],
    'margin-block-start':   ['margin-top'],
    'margin-block-end':     ['margin-bottom'],
    'padding-inline':       ['padding-left', 'padding-right'],
    'padding-block':        ['padding-top',  'padding-bottom'],
    'padding-inline-start': ['padding-left'],
    'padding-inline-end':   ['padding-right'],
    'padding-block-start':  ['padding-top'],
    'padding-block-end':    ['padding-bottom'],
    'inset-inline-start':   ['left'],
    'inset-inline-end':     ['right'],
    'inset-block-start':    ['top'],
    'inset-block-end':      ['bottom'],
    'inset-inline':         ['left', 'right'],
    'inset-block':          ['top',  'bottom'],
    'inset':                ['top', 'right', 'bottom', 'left'],
    'border-inline-start':  ['border-left'],
    'border-inline-end':    ['border-right'],
    'border-block-start':   ['border-top'],
    'border-block-end':     ['border-bottom'],
    'border-start-start-radius': ['border-top-left-radius'],
    'border-start-end-radius':   ['border-top-right-radius'],
    'border-end-start-radius':   ['border-bottom-left-radius'],
    'border-end-end-radius':     ['border-bottom-right-radius'],
    'inline-size':          ['width'],
    'block-size':           ['height'],
    'min-inline-size':      ['min-width'],
    'max-inline-size':      ['max-width'],
    'min-block-size':       ['min-height'],
    'max-block-size':       ['max-height'],
    'overflow-inline':      ['overflow-x'],
    'overflow-block':       ['overflow-y'],
  };
  if (logicalMap[prop]) {
    const targets = logicalMap[prop];
    const vals    = val.trim().split(/\s+/);
    return targets.map((p, i) => ({
      type:'declaration', property: p, value: vals[i] || vals[0]
    }));
  }

  // ── Properties to silently drop ───────────────────────────────────────────
  const dropSet = new Set([
    'backdrop-filter', 'contain', 'will-change', 'isolation', 'mix-blend-mode',
    'forced-color-adjust', 'overscroll-behavior', 'overscroll-behavior-x',
    'overscroll-behavior-y', 'scroll-snap-type', 'scroll-snap-align',
    'scroll-padding', 'scroll-margin', 'scroll-behavior', 'scrollbar-gutter',
    'scrollbar-width', 'scrollbar-color',
    'font-variant-ligatures', 'font-variant-numeric', 'font-variant-caps',
    'font-variant-east-asian', 'font-variant-alternates', 'font-variant',
    'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
    'text-underline-offset', 'text-overflow-mode', 'text-rendering',
    'paint-order', 'shape-outside', 'shape-margin', 'shape-image-threshold',
    'counter-set', 'content-visibility',
    'caret-color', 'accent-color', 'color-scheme', 'forced-colors',
    'offset-path', 'offset-distance', 'offset-rotate', 'offset-anchor',
    'mask', 'mask-image', 'mask-size', 'mask-position', 'mask-repeat',
    'mask-clip', 'mask-composite', 'mask-mode',
    'clip-path', 'clip-rule',
    'writing-mode', 'text-orientation', 'text-combine-upright',
    'ruby-position', 'ruby-align', 'hyphenate-character',
    'overflow-anchor', 'touch-action', 'pointer-events',
    'image-rendering', 'image-resolution',
    'print-color-adjust', 'color-adjust',
    'contain-intrinsic-size', 'container', 'container-type', 'container-name',
    'rotate', 'scale', 'translate', // modern shorthand transforms
  ]);
  if (dropSet.has(prop)) return [];

  // ── transform: modern values ──────────────────────────────────────────────
  if (prop === 'transform' || prop === '-webkit-transform') {
    // Keep it — just prefix it
    val = val.replace(/rotate(X|Y|Z)?\(/gi, (m, a) => 'rotate' + (a||'') + '(');
    return [
      { type:'declaration', property:'-webkit-transform', value: val },
      { type:'declaration', property:'transform',         value: val }
    ];
  }

  // ── @container queries → strip ────────────────────────────────────────────
  if (prop.startsWith('container')) return [];

  // ── Fallback: pass through with value downgrade applied ───────────────────
  decl.value = val;
  return [decl];
}

// ═══════════════════════════════════════════════════════════════════════════════
// §7  CSS SELECTOR DOWNGRADER
// ═══════════════════════════════════════════════════════════════════════════════

function downgradeSelector(s) {
  if (!s) return null;

  // :root → html
  s = s.replace(/:root\b/g, 'html');
  // :is() / :where() → first argument
  s = s.replace(/:is\(([^)]+)\)/g,    (m, a) => a.split(',')[0].trim());
  s = s.replace(/:where\(([^)]+)\)/g, (m, a) => a.split(',')[0].trim());
  // :has() → can't polyfill, drop rule
  if (s.includes(':has(')) return null;
  // :not() — keep only if simple arg
  s = s.replace(/:not\(([^)]+)\)/g, (m, inner) =>
    /^[a-zA-Z0-9.#*[\]="'_-]+$/.test(inner.trim()) ? ':not(' + inner.trim() + ')' : '');
  // Modern pseudo-classes → older equivalents
  s = s.replace(/:focus-visible\b/g,   ':focus');
  s = s.replace(/:focus-within\b/g,    ':focus');
  s = s.replace(/:any-link\b/g,        ':link');
  s = s.replace(/:placeholder-shown\b/g,':focus');
  s = s.replace(/:user-valid\b/g,      ':valid');
  s = s.replace(/:user-invalid\b/g,    ':invalid');
  s = s.replace(/:local-link\b/g,      ':link');
  s = s.replace(/:target-within\b/g,   ':target');
  s = s.replace(/:global\b/g,          '');
  s = s.replace(/:local\b/g,           '');
  // CSS nesting & operator
  s = s.replace(/^&\s*/, '');
  if (s.includes('&')) return null; // nested selector, can't flatten
  // :: pseudo-elements → legacy :
  s = s.replace(/::before\b/g,        ':before');
  s = s.replace(/::after\b/g,         ':after');
  s = s.replace(/::first-line\b/g,    ':first-line');
  s = s.replace(/::first-letter\b/g,  ':first-letter');
  s = s.replace(/::selection\b/g,     '::-webkit-selection');
  s = s.replace(/::placeholder\b/g,   '::-webkit-input-placeholder');
  s = s.replace(/::marker\b/g,        ':before');
  s = s.replace(/::backdrop\b/g,      '');
  s = s.replace(/::file-selector-button\b/g, '::-webkit-file-upload-button');
  s = s.replace(/::slotted\([^)]*\)/g, '');
  s = s.replace(/::part\([^)]*\)/g,   '');
  // Container queries escape
  if (/@container/.test(s)) return null;

  return s.trim() || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §8  CSS RULE PROCESSOR (AST walk)
// ═══════════════════════════════════════════════════════════════════════════════

function processRules(rules, vars) {
  if (!rules) return [];
  const out = [];
  for (const rule of rules) {
    if (!rule) continue;

    if (rule.type === 'rule') {
      const selectors = (rule.selectors || []).map(downgradeSelector).filter(Boolean);
      if (!selectors.length) continue;
      rule.selectors = selectors;
      const newDecls = [];
      for (const d of (rule.declarations || [])) {
        if (!d || d.type !== 'declaration') { newDecls.push(d); continue; }
        for (const nd of downgradeCSSProperty(d, vars)) newDecls.push(nd);
      }
      rule.declarations = newDecls;
      if (!newDecls.length) continue;
      out.push(rule);

    } else if (rule.type === 'keyframes') {
      if (rule.keyframes) {
        for (const kf of rule.keyframes) {
          const nd = [];
          for (const kd of (kf.declarations || [])) {
            if (!kd || kd.type !== 'declaration') { nd.push(kd); continue; }
            for (const r of downgradeCSSProperty(kd, vars)) nd.push(r);
          }
          kf.declarations = nd;
        }
      }
      out.push({ type:'keyframes', name: rule.name, vendor:'-webkit-', keyframes: rule.keyframes });
      out.push(rule);

    } else if (rule.type === 'media') {
      const mq = (rule.media || '').toLowerCase();
      // Drop media queries for features 3DS can't handle
      if (/prefers-color-scheme|prefers-reduced-motion|prefers-contrast|forced-colors|display-mode|hover|pointer|any-hover|any-pointer/.test(mq)) continue;
      // @container media → skip
      if (/@container/.test(mq)) continue;
      // rem → px in media queries
      rule.media = rule.media.replace(/([\d.]+)rem/g, (m, n) => Math.round(+n * 16) + 'px');
      // dvw/dvh/svw/svh → vw/vh
      rule.media = rule.media.replace(/([\d.]+)(dv|sv|lv)(w|h)/gi, (m, n, p, u) => n + 'v' + u);
      const innerRules = processRules(rule.rules, vars);
      if (!innerRules.length) continue;
      rule.rules = innerRules;
      out.push(rule);

    } else if (rule.type === 'supports') {
      // Flatten @supports — just run inner rules through (we can't evaluate)
      for (const r of processRules(rule.rules, vars)) out.push(r);

    } else if (rule.type === 'font-face') {
      const fnd = [];
      for (const fd of (rule.declarations || [])) {
        if (!fd || fd.type !== 'declaration') { fnd.push(fd); continue; }
        if (['font-display','font-variation-settings','font-feature-settings',
             'font-named-instance','unicode-range','size-adjust',
             'ascent-override','descent-override','line-gap-override'].includes(fd.property))
          continue;
        // Prioritize WOFF/TTF over WOFF2 in src
        if (fd.property === 'src') {
          // Keep all formats but reorder: WOFF first, then WOFF2 last
          fd.value = fd.value.replace(/format\(['"]?woff2['"]?\)/gi, 'format("woff2")');
          fnd.push(fd);
        } else {
          fnd.push(fd);
        }
      }
      rule.declarations = fnd;
      out.push(rule);

    } else if (rule.type === 'charset') {
      out.push(rule);

    } else if (rule.type === 'layer' || rule.type === 'scope') {
      // Flatten @layer / @scope — extract inner rules
      if (rule.rules)
        for (const r of processRules(rule.rules, vars)) out.push(r);

    } else if (rule.type === 'document') {
      // @document — flatten
      if (rule.rules)
        for (const r of processRules(rule.rules, vars)) out.push(r);

    } else if (rule.type === 'host') {
      // Shadow DOM host — flatten
      if (rule.rules)
        for (const r of processRules(rule.rules, vars)) out.push(r);

    } else {
      out.push(rule);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §9  MAIN CSS TRANSFORM PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

function transformCSS(rawCss, baseUrl, proxyBase) {
  if (!rawCss) return '';
  // Truncate enormous files (keeps parse time sane on the server)
  if (rawCss.length > MAX_CSS_BYTES) rawCss = rawCss.slice(0, MAX_CSS_BYTES) + '\n/* [proxy: truncated] */';

  const vars = extractCSSVars(rawCss);

  // ── Proxy @import ────────────────────────────────────────────────────────
  rawCss = rawCss.replace(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)([^;]*);/g, (m, u, mq) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(baseUrl, u);
    return "@import url('" + proxyBase + '/css?url=' + encodeURIComponent(abs) + '&base=' + encodeURIComponent(abs) + "')" + mq + ';';
  });
  rawCss = rawCss.replace(/@import\s+['"]([^'"]+)['"]([^;]*);/g, (m, u, mq) => {
    if (u.startsWith('data:')) return m;
    const abs = resolveUrl(baseUrl, u);
    return "@import '" + proxyBase + '/css?url=' + encodeURIComponent(abs) + '&base=' + encodeURIComponent(abs) + "'" + mq + ';';
  });

  // ── Proxy url() references ───────────────────────────────────────────────
  rawCss = rawCss.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('about:')) return match;
    const abs = resolveUrl(baseUrl, u);
    if (!abs || abs.startsWith('data:')) return match;
    return "url('" + proxyBase + '/resource?url=' + encodeURIComponent(abs) + "')";
  });

  // ── Strip bare @layer declarations ───────────────────────────────────────
  rawCss = rawCss.replace(/@layer\s+[\w.,\s]+;/g, '');
  // ── Strip @container queries ──────────────────────────────────────────────
  rawCss = rawCss.replace(/@container[^{]*\{/g, '/* @container start */').replace(/\/\* @container start \*\/[^}]*\}/g, '');

  // ── CSS nesting → flatten (best effort) ──────────────────────────────────
  // Remove CSS nesting `&` rules which the AST parser will choke on
  rawCss = rawCss.replace(/&\s*\{[^}]*\}/g, '');

  try {
    const ast = css.parse(rawCss, { silent: true, source: baseUrl });
    if (ast && ast.stylesheet)
      ast.stylesheet.rules = processRules(ast.stylesheet.rules, vars);
    return css.stringify(ast, { compress: false });
  } catch (e) {
    return rawCss; // return unchanged if AST parse fails
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §10  JAVASCRIPT TRANSFORM  (ES6+ → ES5-compatible)
// ═══════════════════════════════════════════════════════════════════════════════

function transformJS(src, proxyBase) {
  if (!src) return src;
  if (src.length > MAX_JS_BYTES) return src; // too large, skip — less damage than mangling large minified files

  try {
    src = src
      // ── ES6 declarations ─────────────────────────────────────────────────
      .replace(/\b(const|let)\b/g, 'var')

      // ── Arrow functions ───────────────────────────────────────────────────
      .replace(/\(([^)]*)\)\s*=>\s*\{/g, 'function($1){')
      .replace(/\(([^)]*)\)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')
      .replace(/(\b\w+)\s*=>\s*\{/g, 'function($1){')
      .replace(/(\b\w+)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')

      // ── Template literals (simple — one interpolation at a time) ──────────
      .replace(/`([^`]*?)\$\{([^}]+)\}([^`]*?)`/g,
        (m, pre, expr, post) => '"' + pre.replace(/"/g,'\\"') + '"+(' + expr + ')+"' + post.replace(/"/g,'\\"') + '"')
      .replace(/`([^`]*)`/g, (m, s) => '"' + s.replace(/"/g,'\\"').replace(/\n/g,'\\n') + '"')

      // ── Async / await (best-effort — drop keywords, not semantics) ────────
      .replace(/\basync\s+function\b/g, 'function')
      .replace(/\basync\s+\(/g, '(')
      .replace(/\bawait\s+/g, '/* await */ ')

      // ── for...of (array only) ─────────────────────────────────────────────
      .replace(/for\s*\(\s*var\s+(\w+)\s+of\s+(\w+)\s*\)/g,
        (m, v, arr) => 'for(var __fi=0,' + v + ';__fi<' + arr + '.length;' + v + '=' + arr + '[__fi],__fi++)')

      // ── Spread in arrays: [...x] → x ──────────────────────────────────────
      .replace(/\[\.\.\.(\w+)\]/g, '$1')
      // ── Rest/spread in args ────────────────────────────────────────────────
      .replace(/,\s*\.\.\.(\w+)/g, ', $1')

      // ── Object destructuring: var {a,b} = obj ─────────────────────────────
      .replace(/var\s*\{\s*([\w\s,:]+)\s*\}\s*=\s*(\w+)/g, (m, keys, obj) => {
        return keys.split(',').map(k => {
          const [orig, alias] = k.trim().split(':').map(s => s.trim());
          const target = alias || orig;
          return 'var ' + target + '=' + obj + '.' + orig;
        }).join(';');
      })

      // ── Array destructuring: var [a,b] = arr ──────────────────────────────
      .replace(/var\s*\[\s*([\w\s,]+)\s*\]\s*=\s*(\w+)/g, (m, keys, arr) =>
        keys.split(',').map((k, i) => 'var ' + k.trim() + '=' + arr + '[' + i + ']').join(';'))

      // ── Default params: function(x=1) → strip defaults ────────────────────
      .replace(/function\s*(\w*)\s*\(([^)]*)\)/g, (m, name, args) =>
        'function ' + name + '(' + args.replace(/=\s*[^,)]+/g, '') + ')')

      // ── Shorthand method: { foo() {} } → { foo: function() {} } ──────────
      .replace(/(\w+)\s*\(([^)]*)\)\s*\{/g, (m, name, args) => {
        if (/^(if|for|while|switch|catch|function)$/.test(name)) return m;
        return name + ': function(' + args + '){';
      })

      // ── Proxy location navigations through proxy ──────────────────────────
      .replace(/((?:window\.)?location\.href\s*=\s*)(['"])(https?:\/\/[^'"]+)(['"])/g,
        (m, pre, q1, u, q2) => pre + q1 + proxyBase + '/proxy?url=' + encodeURIComponent(u) + q2)

      // ── Block unsupported-browser walls ───────────────────────────────────
      .replace(/window\.location\s*=\s*['"][^'"]*unsupported[^'"]*['"]/gi, '/* blocked */')

      // ── document.write → no-op ────────────────────────────────────────────
      .replace(/document\.write\s*\(/g, 'void (')

      // ── import/export statements → no-op ─────────────────────────────────
      .replace(/^\s*import\s+.*?from\s+['"][^'"]*['"];?\s*$/gm, '/* import removed */')
      .replace(/^\s*export\s+(default\s+)?/gm, '/* export */ ')

      // ── Nullish coalescing ?? → || ────────────────────────────────────────
      .replace(/\?\?/g, '||')

      // ── Optional chaining ?. → simple property access (best effort) ───────
      .replace(/\?\.\[/g, '[')
      .replace(/\?\.\(/g, '(')
      .replace(/\?\./g,   '.')

      // ── Logical assignment operators ──────────────────────────────────────
      .replace(/(\w+)\s*\|\|=\s*/g, '$1 = $1 || ')
      .replace(/(\w+)\s*&&=\s*/g,   '$1 = $1 && ')
      .replace(/(\w+)\s*\?\?=\s*/g, '$1 = $1 || ')

      // ── BigInt literals → Number ───────────────────────────────────────────
      .replace(/(\d+)n\b/g, '$1')

      // ── globalThis → window ────────────────────────────────────────────────
      .replace(/\bglobalThis\b/g, 'window')

      // ── Object spread: {...a, b:1} → Object.assign({}, a, {b:1}) ─────────
      // (simplified — catches most common patterns)
      .replace(/\{\.\.\.(\w+)\s*(?:,\s*([^}]+))?\}/g, (m, obj, rest) =>
        rest ? 'Object.assign({},'+obj+',{'+rest+'})' : 'Object.assign({},'+obj+')')

      // ── String.raw, String.cooked → plain string ───────────────────────────
      .replace(/String\.raw`([^`]*)`/g, '"$1"');

    return src;
  } catch { return src; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// §11  SHIM BLOCK  (injected into every proxied page's <head>)
// ═══════════════════════════════════════════════════════════════════════════════

function buildShims(proxyBase, targetUrl) {
  const ua = MODERN_UA.replace(/'/g, "\\'");
  return `<script>
/* ===== 3DS PROXY SHIMS v2 ===== */
/* UA spoofing */
try{Object.defineProperty(navigator,'userAgent',{get:function(){return '${ua}';}});}catch(e){}
try{Object.defineProperty(navigator,'vendor',{get:function(){return 'Google Inc.';}});}catch(e){}
try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';}});}catch(e){}
try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 1;}});}catch(e){}
try{Object.defineProperty(navigator,'connection',{get:function(){return{effectiveType:'4g',downlink:10,rtt:50,saveData:false};}});}catch(e){}

/* Globals */
window.chrome=window.chrome||{runtime:{},app:{isInstalled:false}};
window.CSS=window.CSS||{supports:function(){return false;},escape:function(s){return s;}};
window.console=window.console||{log:function(){},warn:function(){},error:function(){},info:function(){},debug:function(){}};
window.__3DS_PROXY__=true;

/* CustomEvent */
if(typeof CustomEvent==='undefined'||typeof CustomEvent!=='function'){window.CustomEvent=function(t,p){p=p||{};var e=document.createEvent('Event');e.initEvent(t,!!p.bubbles,!!p.cancelable);e.detail=p.detail||null;return e;};}

/* Storage */
if(!window.sessionStorage){try{window.sessionStorage={_d:{},getItem:function(k){return this._d.hasOwnProperty(k)?this._d[k]:null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};},key:function(i){return Object.keys(this._d)[i]||null;},get length(){return Object.keys(this._d).length;}};}catch(e){}}
if(!window.localStorage){try{window.localStorage={_d:{},getItem:function(k){return this._d.hasOwnProperty(k)?this._d[k]:null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};},key:function(i){return Object.keys(this._d)[i]||null;},get length(){return Object.keys(this._d).length;}};}catch(e){}}

/* Promise */
if(!window.Promise){
  window.Promise=function(fn){this._s=0;this._v=undefined;this._t=[];this._c=[];var self=this;function res(v){if(self._s)return;self._s=1;self._v=v;self._t.forEach(function(f){setTimeout(function(){f(v);},0);});}function rej(v){if(self._s)return;self._s=2;self._v=v;self._c.forEach(function(f){setTimeout(function(){f(v);},0);});}try{fn(res,rej);}catch(e){rej(e);}};
  window.Promise.prototype.then=function(onF,onR){var self=this;return new window.Promise(function(res,rej){var wrap=function(){if(self._s===1){try{res(onF?onF(self._v):self._v);}catch(e){rej(e);}}else if(self._s===2){if(onR){try{res(onR(self._v));}catch(e){rej(e);}}else rej(self._v);}};if(self._s)setTimeout(wrap,0);else{self._t.push(function(v){try{res(onF?onF(v):v);}catch(e){rej(e);}});self._c.push(function(v){if(onR){try{res(onR(v));}catch(e){rej(e);}}else rej(v);});}});};
  window.Promise.prototype.catch=function(fn){return this.then(null,fn);};
  window.Promise.prototype.finally=function(fn){return this.then(function(v){fn();return v;},function(e){fn();throw e;});};
  window.Promise.resolve=function(v){return new window.Promise(function(r){r(v);});};
  window.Promise.reject=function(v){return new window.Promise(function(_,r){r(v);});};
  window.Promise.all=function(arr){return new window.Promise(function(res,rej){if(!arr.length)return res([]);var out=[],n=arr.length;arr.forEach(function(p,i){window.Promise.resolve(p).then(function(v){out[i]=v;if(!--n)res(out);},rej);});});};
  window.Promise.allSettled=function(arr){return window.Promise.all(arr.map(function(p){return window.Promise.resolve(p).then(function(v){return{status:'fulfilled',value:v};},function(e){return{status:'rejected',reason:e};});}));};
  window.Promise.race=function(arr){return new window.Promise(function(res,rej){arr.forEach(function(p){window.Promise.resolve(p).then(res,rej);});});};
  window.Promise.any=function(arr){return new window.Promise(function(res,rej){var n=arr.length,errs=[];if(!n)return rej(new Error('All promises rejected'));arr.forEach(function(p){window.Promise.resolve(p).then(res,function(e){errs.push(e);if(!--n)rej(new Error('All promises rejected'));});});});};
}

/* fetch */
if(!window.fetch){window.fetch=function(url,opts){return new window.Promise(function(res,rej){var xhr=new XMLHttpRequest();opts=opts||{};xhr.open(opts.method||'GET',url,true);if(opts.headers){for(var k in opts.headers)try{xhr.setRequestHeader(k,opts.headers[k]);}catch(e){}}xhr.responseType='arraybuffer';xhr.onload=function(){var ab=xhr.response;var text=new TextDecoder('utf-8').decode(ab);res({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,statusText:xhr.statusText,arrayBuffer:function(){return window.Promise.resolve(ab);},text:function(){return window.Promise.resolve(text);},json:function(){return window.Promise.resolve(JSON.parse(text));},headers:{get:function(h){return xhr.getResponseHeader(h);}}});};xhr.onerror=function(){rej(new Error('fetch failed'));};try{xhr.send(opts.body||null);}catch(e){rej(e);}});};}

/* Array polyfills */
if(!Array.prototype.forEach){Array.prototype.forEach=function(fn,ctx){for(var i=0;i<this.length;i++)if(i in this)fn.call(ctx,this[i],i,this);};}
if(!Array.prototype.map){Array.prototype.map=function(fn,ctx){var r=[];for(var i=0;i<this.length;i++)r.push(fn.call(ctx,this[i],i,this));return r;};}
if(!Array.prototype.filter){Array.prototype.filter=function(fn,ctx){var r=[];for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))r.push(this[i]);return r;};}
if(!Array.prototype.reduce){Array.prototype.reduce=function(fn,init){var i=0,acc;if(arguments.length>1){acc=init;}else{acc=this[0];i=1;}for(;i<this.length;i++)acc=fn(acc,this[i],i,this);return acc;};}
if(!Array.prototype.indexOf){Array.prototype.indexOf=function(v,s){for(var i=s||0;i<this.length;i++)if(this[i]===v)return i;return -1;};}
if(!Array.prototype.some){Array.prototype.some=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return true;return false;};}
if(!Array.prototype.every){Array.prototype.every=function(fn,ctx){for(var i=0;i<this.length;i++)if(!fn.call(ctx,this[i],i,this))return false;return true;};}
if(!Array.prototype.find){Array.prototype.find=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return this[i];};}
if(!Array.prototype.findIndex){Array.prototype.findIndex=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return i;return -1;};}
if(!Array.prototype.includes){Array.prototype.includes=function(v,s){return this.indexOf(v,s)!==-1;};}
if(!Array.prototype.flat){Array.prototype.flat=function(d){d=d===undefined?1:d;var r=[];for(var i=0;i<this.length;i++){if(Array.isArray(this[i])&&d>0)r=r.concat(this[i].flat(d-1));else r.push(this[i]);}return r;};}
if(!Array.prototype.flatMap){Array.prototype.flatMap=function(fn,ctx){return this.map(fn,ctx).flat(1);};}
if(!Array.prototype.fill){Array.prototype.fill=function(v,s,e){s=s||0;e=e===undefined?this.length:e;for(var i=s;i<e;i++)this[i]=v;return this;};}
if(!Array.from){Array.from=function(a,fn){var r=[];var l=a&&a.length||0;for(var i=0;i<l;i++)r.push(fn?fn(a[i],i):a[i]);return r;};}
if(!Array.isArray){Array.isArray=function(a){return Object.prototype.toString.call(a)==='[object Array]';};}
if(!Array.of){Array.of=function(){return Array.prototype.slice.call(arguments);};}

/* Object */
if(!Object.assign){Object.assign=function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s)for(var k in s)if(Object.prototype.hasOwnProperty.call(s,k))t[k]=s[k];}return t;};}
if(!Object.keys){Object.keys=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(k);return r;};}
if(!Object.values){Object.values=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(o[k]);return r;};}
if(!Object.entries){Object.entries=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push([k,o[k]]);return r;};}
if(!Object.create){Object.create=function(p,d){function F(){}F.prototype=p;var o=new F();if(d)for(var k in d)o[k]=d[k].value;return o;};}
if(!Object.freeze){Object.freeze=function(o){return o;};}
if(!Object.is){Object.is=function(a,b){if(a===b)return a!==0||1/a===1/b;return a!==a&&b!==b;};}
if(!Object.fromEntries){Object.fromEntries=function(entries){var o={};var arr=Array.from(entries);for(var i=0;i<arr.length;i++)o[arr[i][0]]=arr[i][1];return o;};}
if(!Object.getPrototypeOf){Object.getPrototypeOf=function(o){return o.__proto__||null;};}
if(!Object.getOwnPropertyNames){Object.getOwnPropertyNames=Object.keys;}
if(!Object.getOwnPropertyDescriptor){Object.getOwnPropertyDescriptor=function(o,k){return o.hasOwnProperty(k)?{value:o[k],writable:true,enumerable:true,configurable:true}:undefined;};}

/* String */
if(!String.prototype.trim){String.prototype.trim=function(){return this.replace(/^\s+|\s+$/g,'');};}
if(!String.prototype.trimStart){String.prototype.trimStart=function(){return this.replace(/^\s+/,'');};}
if(!String.prototype.trimEnd){String.prototype.trimEnd=function(){return this.replace(/\s+$/,'');};}
if(!String.prototype.startsWith){String.prototype.startsWith=function(s,p){return this.slice(p||0,s.length+(p||0))===s;};}
if(!String.prototype.endsWith){String.prototype.endsWith=function(s,l){var e=l===undefined?this.length:l;return this.slice(e-s.length,e)===s;};}
if(!String.prototype.includes){String.prototype.includes=function(s,p){return this.indexOf(s,p||0)!==-1;};}
if(!String.prototype.repeat){String.prototype.repeat=function(n){var r='';for(var i=0;i<n;i++)r+=this;return r;};}
if(!String.prototype.padStart){String.prototype.padStart=function(n,p){p=String(p===undefined?' ':p);var s=String(this);if(s.length>=n)return s;var needed=n-s.length;while(p.length<needed)p+=p;return p.slice(0,needed)+s;};}
if(!String.prototype.padEnd){String.prototype.padEnd=function(n,p){p=String(p===undefined?' ':p);var s=String(this);if(s.length>=n)return s;var needed=n-s.length;while(p.length<needed)p+=p;return s+p.slice(0,needed);};}
if(!String.prototype.replaceAll){String.prototype.replaceAll=function(s,r){if(s instanceof RegExp)return this.replace(s,r);return this.split(s).join(r);};}
if(!String.prototype.at){String.prototype.at=function(i){var n=i<0?this.length+i:i;return n<0||n>=this.length?undefined:this[n];};}
if(!String.fromCodePoint){String.fromCodePoint=function(){var r='';for(var i=0;i<arguments.length;i++){var c=arguments[i];if(c>0xFFFF){c-=0x10000;r+=String.fromCharCode(0xD800+(c>>10),0xDC00+(c&0x3FF));}else r+=String.fromCharCode(c);}return r;};}

/* Number */
if(!Number.isInteger){Number.isInteger=function(v){return typeof v==='number'&&isFinite(v)&&Math.floor(v)===v;};}
if(!Number.isFinite){Number.isFinite=function(v){return typeof v==='number'&&isFinite(v);};}
if(!Number.isNaN){Number.isNaN=function(v){return typeof v==='number'&&v!==v;};}
if(!Number.parseInt){Number.parseInt=parseInt;}
if(!Number.parseFloat){Number.parseFloat=parseFloat;}
if(!Number.EPSILON){Number.EPSILON=2.220446049250313e-16;}
if(!Number.MAX_SAFE_INTEGER){Number.MAX_SAFE_INTEGER=9007199254740991;}

/* Math */
if(!Math.sign){Math.sign=function(x){return x>0?1:x<0?-1:0;};}
if(!Math.trunc){Math.trunc=function(x){return x<0?Math.ceil(x):Math.floor(x);};}
if(!Math.log2){Math.log2=function(x){return Math.log(x)/0.6931471805599453;};}
if(!Math.log10){Math.log10=function(x){return Math.log(x)/2.302585092994046;};}
if(!Math.hypot){Math.hypot=function(){var s=0;for(var i=0;i<arguments.length;i++)s+=arguments[i]*arguments[i];return Math.sqrt(s);};}
if(!Math.cbrt){Math.cbrt=function(x){return x<0?-Math.pow(-x,1/3):Math.pow(x,1/3);};}
if(!Math.clz32){Math.clz32=function(x){if(!x)return 32;var n=0;if(!(x&0xFFFF0000)){n+=16;x<<=16;}if(!(x&0xFF000000)){n+=8;x<<=8;}if(!(x&0xF0000000)){n+=4;x<<=4;}if(!(x&0xC0000000)){n+=2;x<<=2;}return n+!(x&0x80000000);};}
if(!Math.imul){Math.imul=function(a,b){var ah=a>>>16,al=a&0xFFFF,bh=b>>>16,bl=b&0xFFFF;return(al*bl)+((ah*bl+al*bh)<<16)|0;};}

/* JSON */
var _jp=JSON.parse;JSON.parse=function(s){try{return _jp(s);}catch(e){try{return eval('('+s+')');}catch(e2){return null;}}};

/* Date */
if(!Date.now){Date.now=function(){return new Date().getTime();};}

/* requestAnimationFrame */
if(!window.requestAnimationFrame){window.requestAnimationFrame=function(fn){return setTimeout(fn,16);};}
if(!window.cancelAnimationFrame){window.cancelAnimationFrame=function(id){clearTimeout(id);};}

/* performance */
if(!window.performance){window.performance={now:function(){return Date.now();},timing:{},mark:function(){},measure:function(){},getEntriesByType:function(){return[];}};}
else if(!window.performance.now){window.performance.now=function(){return Date.now();};}
if(!window.performance.mark){window.performance.mark=function(){};}
if(!window.performance.measure){window.performance.measure=function(){};}

/* queueMicrotask */
if(!window.queueMicrotask){window.queueMicrotask=function(fn){if(window.Promise)window.Promise.resolve().then(fn);else setTimeout(fn,0);};}

/* URL */
if(typeof window.URL==='undefined'){
  window.URL=function(href,base){
    if(base){var ba=document.createElement('a');ba.href=base;href=ba.href.replace(/[^/]*$/,'')+href.replace(/^\.\//,'');}
    var a=document.createElement('a');a.href=href;
    this.href=a.href;this.protocol=a.protocol;this.host=a.host;this.hostname=a.hostname;
    this.port=a.port;this.pathname=a.pathname;this.search=a.search;this.hash=a.hash;
    this.origin=a.protocol+'//'+a.host;
    var q={};(a.search||'').replace(/^\?/,'').split('&').forEach(function(p){if(!p)return;var kv=p.split('=');q[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||'');});
    this.searchParams={_q:q,get:function(k){return this._q[k]||null;},set:function(k,v){this._q[k]=v;},has:function(k){return k in this._q;},toString:function(){return Object.keys(this._q).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(this._q[k]);},this).join('&');}};
  };
  window.URL.createObjectURL=function(){return '';};
  window.URL.revokeObjectURL=function(){};
}

/* URLSearchParams */
if(typeof URLSearchParams==='undefined'){window.URLSearchParams=function(init){this._d={};var self=this;if(typeof init==='string')(init.replace(/^\?/,'').split('&')).forEach(function(p){if(!p)return;var kv=p.split('=');self._d[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||'');});this.get=function(k){return this._d[k]||null;};this.set=function(k,v){this._d[k]=String(v);};this.has=function(k){return this._d.hasOwnProperty(k);};this.delete=function(k){delete this._d[k];};this.toString=function(){return Object.keys(this._d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(this._d[k]);},this).join('&');};};}

/* Symbol */
if(typeof Symbol==='undefined'){var _sc=0;window.Symbol=function(d){return '__sym_'+(d||'')+(_sc++)+'__';};window.Symbol.iterator='__sym_iterator__';window.Symbol.hasInstance='__sym_hasInstance__';window.Symbol.toPrimitive='__sym_toPrimitive__';window.Symbol.toStringTag='__sym_toStringTag__';window.Symbol.for=function(k){return '__symfor_'+k+'__';};}

/* WeakMap / WeakSet */
if(typeof WeakMap==='undefined'){window.WeakMap=function(){this._k=[];this._v=[];};window.WeakMap.prototype={get:function(k){var i=this._k.indexOf(k);return i>-1?this._v[i]:undefined;},set:function(k,v){var i=this._k.indexOf(k);if(i>-1)this._v[i]=v;else{this._k.push(k);this._v.push(v);}return this;},has:function(k){return this._k.indexOf(k)>-1;},delete:function(k){var i=this._k.indexOf(k);if(i>-1){this._k.splice(i,1);this._v.splice(i,1);}return true;}};}
if(typeof WeakSet==='undefined'){window.WeakSet=function(){this._i=[];};window.WeakSet.prototype={add:function(v){if(!this.has(v))this._i.push(v);return this;},has:function(v){return this._i.indexOf(v)>-1;},delete:function(v){var i=this._i.indexOf(v);if(i>-1)this._i.splice(i,1);return true;}};}

/* Map */
if(typeof Map==='undefined'){window.Map=function(init){this._k=[];this._v=[];if(init){var arr=Array.from(init);for(var i=0;i<arr.length;i++)this.set(arr[i][0],arr[i][1]);}};window.Map.prototype={get:function(k){var i=this._k.indexOf(k);return i>-1?this._v[i]:undefined;},set:function(k,v){var i=this._k.indexOf(k);if(i>-1)this._v[i]=v;else{this._k.push(k);this._v.push(v);}return this;},has:function(k){return this._k.indexOf(k)>-1;},delete:function(k){var i=this._k.indexOf(k);if(i>-1){this._k.splice(i,1);this._v.splice(i,1);}return true;},clear:function(){this._k=[];this._v=[];},forEach:function(fn,ctx){for(var i=0;i<this._k.length;i++)fn.call(ctx,this._v[i],this._k[i],this);},get size(){return this._k.length;},keys:function(){var k=this._k.slice(),i=0;return{next:function(){return i<k.length?{value:k[i++],done:false}:{done:true};}};},values:function(){var v=this._v.slice(),i=0;return{next:function(){return i<v.length?{value:v[i++],done:false}:{done:true};}};},entries:function(){var k=this._k.slice(),v=this._v.slice(),i=0;return{next:function(){return i<k.length?{value:[k[i],v[i++]],done:false}:{done:true};}};}};}

/* Set */
if(typeof Set==='undefined'){window.Set=function(init){this._i=[];if(init){var arr=Array.from(init);for(var i=0;i<arr.length;i++)this.add(arr[i]);}};window.Set.prototype={add:function(v){if(!this.has(v))this._i.push(v);return this;},has:function(v){return this._i.indexOf(v)>-1;},delete:function(v){var i=this._i.indexOf(v);if(i>-1){this._i.splice(i,1);}return true;},clear:function(){this._i=[];},forEach:function(fn,ctx){for(var i=0;i<this._i.length;i++)fn.call(ctx,this._i[i],this._i[i],this);},get size(){return this._i.length;},values:function(){var d=this._i.slice(),i=0;return{next:function(){return i<d.length?{value:d[i++],done:false}:{done:true};}};},keys:function(){return this.values();},entries:function(){var d=this._i.slice(),i=0;return{next:function(){return i<d.length?{value:[d[i],d[i++]],done:false}:{done:true};}};}};}

/* Proxy stub / Reflect */
if(typeof Proxy==='undefined'){window.Proxy=function(t,h){return t;};}
if(typeof Reflect==='undefined'){window.Reflect={apply:function(fn,ctx,args){return fn.apply(ctx,args);},construct:function(T,args){function F(){return T.apply(this,args);}F.prototype=T.prototype;return new F();},ownKeys:Object.keys,has:function(t,k){return k in t;},get:function(t,k){return t[k];},set:function(t,k,v){t[k]=v;return true;},deleteProperty:function(t,k){delete t[k];return true;}};}

/* MutationObserver stub */
if(typeof MutationObserver==='undefined'){window.MutationObserver=function(){};window.MutationObserver.prototype={observe:function(){},disconnect:function(){},takeRecords:function(){return[];}};}

/* IntersectionObserver stub — immediately fire callback with isIntersecting=true */
if(typeof IntersectionObserver==='undefined'){
  window.IntersectionObserver=function(fn,opts){this._fn=fn;this._els=[];};
  window.IntersectionObserver.prototype={
    observe:function(el){var self=this;setTimeout(function(){try{self._fn([{isIntersecting:true,target:el,intersectionRatio:1}],self);}catch(e){}},10);},
    unobserve:function(){},disconnect:function(){},takeRecords:function(){return[];}
  };
}

/* ResizeObserver stub */
if(typeof ResizeObserver==='undefined'){window.ResizeObserver=function(fn){this._fn=fn;};window.ResizeObserver.prototype={observe:function(){},unobserve:function(){},disconnect:function(){}};}

/* Element methods */
if(typeof document!=='undefined'&&document.documentElement){
  if(!Element.prototype.remove){Element.prototype.remove=function(){if(this.parentNode)this.parentNode.removeChild(this);};}
  if(!Element.prototype.matches){Element.prototype.matches=Element.prototype.msMatchesSelector||Element.prototype.webkitMatchesSelector||function(s){var el=this,m=(el.ownerDocument||el.document).querySelectorAll(s),i=m.length;while(--i>=0&&m.item(i)!==el){}return i>-1;};}
  if(!Element.prototype.closest){Element.prototype.closest=function(s){var el=this;while(el&&el.nodeType===1){try{if(el.matches(s))return el;}catch(e){}el=el.parentElement||el.parentNode;}return null;};}
  if(!Element.prototype.prepend){Element.prototype.prepend=function(){var args=Array.prototype.slice.call(arguments);for(var i=args.length-1;i>=0;i--){var n=args[i];this.insertBefore(typeof n==='string'?document.createTextNode(n):n,this.firstChild);}};}
  if(!Element.prototype.append){Element.prototype.append=function(){Array.prototype.slice.call(arguments).forEach(function(n){this.appendChild(typeof n==='string'?document.createTextNode(n):n);},this);};}
  if(!Element.prototype.before){Element.prototype.before=function(n){if(this.parentNode)this.parentNode.insertBefore(typeof n==='string'?document.createTextNode(n):n,this);};}
  if(!Element.prototype.after){Element.prototype.after=function(n){if(this.parentNode)this.parentNode.insertBefore(typeof n==='string'?document.createTextNode(n):n,this.nextSibling);};}
  if(!Element.prototype.replaceWith){Element.prototype.replaceWith=function(n){if(this.parentNode)this.parentNode.replaceChild(typeof n==='string'?document.createTextNode(n):n,this);};}
  if(!Element.prototype.getAttributeNames){Element.prototype.getAttributeNames=function(){var r=[];for(var i=0;i<this.attributes.length;i++)r.push(this.attributes[i].name);return r;};}
  if(typeof NodeList!=='undefined'&&NodeList.prototype&&!NodeList.prototype.forEach){NodeList.prototype.forEach=Array.prototype.forEach;}
  if(typeof HTMLCollection!=='undefined'&&HTMLCollection.prototype&&!HTMLCollection.prototype.forEach){HTMLCollection.prototype.forEach=Array.prototype.forEach;}

  /* classList */
  if(typeof document.documentElement.classList==='undefined'){
    Object.defineProperty(Element.prototype,'classList',{get:function(){
      var el=this;
      return {
        _c:function(){return(el.className||'').split(/\s+/).filter(function(x){return x;});},
        contains:function(c){return this._c().indexOf(c)>-1;},
        add:function(){var c=Array.prototype.slice.call(arguments),self=this;c.forEach(function(cls){if(!self.contains(cls))el.className=(el.className?el.className+' ':'')+cls;});},
        remove:function(){var c=Array.prototype.slice.call(arguments),self=this;el.className=self._c().filter(function(x){return c.indexOf(x)===-1;}).join(' ');},
        toggle:function(c,f){var has=this.contains(c);if(f===undefined?has:f){this.remove(c);}else{this.add(c);}return this.contains(c);},
        replace:function(a,b){this.remove(a);this.add(b);},
        item:function(i){return this._c()[i]||null;},
        get length(){return this._c().length;}
      };
    }});
  }

  /* dataset */
  if(typeof document.documentElement.dataset==='undefined'){
    Object.defineProperty(Element.prototype,'dataset',{get:function(){
      var el=this,d={};
      for(var i=0;i<el.attributes.length;i++){
        var a=el.attributes[i];
        if(a.name.indexOf('data-')===0){
          var k=a.name.slice(5).replace(/-([a-z])/g,function(m,c){return c.toUpperCase();});
          d[k]=a.value;
        }
      }
      return d;
    }});
  }

  /* querySelectorAll safety */
  var _qsa=document.querySelectorAll.bind(document);
  document.querySelectorAll=function(s){try{return _qsa(s);}catch(e){return [];}};
  var _qs=document.querySelector.bind(document);
  document.querySelector=function(s){try{return _qs(s);}catch(e){return null;}};
}

/* getComputedStyle */
if(!window.getComputedStyle){window.getComputedStyle=function(el){return el.currentStyle||{};};}
/* getSelection */
if(!window.getSelection){window.getSelection=function(){return{toString:function(){return'';},rangeCount:0,removeAllRanges:function(){}};};}
/* matchMedia */
if(!window.matchMedia){window.matchMedia=function(q){return{matches:false,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false;}};};}

/* TextDecoder/Encoder */
if(typeof TextDecoder==='undefined'){window.TextDecoder=function(enc){this.enc=enc||'utf-8';};window.TextDecoder.prototype.decode=function(u){if(!u)return'';var s='';for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return s;};}
if(typeof TextEncoder==='undefined'){window.TextEncoder=function(){this.encoding='utf-8';};window.TextEncoder.prototype.encode=function(s){var u=[];for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<0x80)u.push(c);else if(c<0x800){u.push(0xC0|(c>>6));u.push(0x80|(c&63));}else{u.push(0xE0|(c>>12));u.push(0x80|((c>>6)&63));u.push(0x80|(c&63));}}return new Uint8Array(u);};}

/* TypedArrays */
if(typeof Uint8Array==='undefined'){window.Uint8Array=window.Int8Array=window.Uint8ClampedArray=window.Int16Array=window.Uint16Array=window.Int32Array=window.Uint32Array=window.Float32Array=window.Float64Array=Array;}

/* btoa/atob */
if(!window.btoa){window.btoa=function(s){var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var r='';for(var i=0;i<s.length;i+=3){var b=s.charCodeAt(i)<<16|(i+1<s.length?s.charCodeAt(i+1):0)<<8|(i+2<s.length?s.charCodeAt(i+2):0);r+=chars[b>>18&63]+chars[b>>12&63]+(i+1<s.length?chars[b>>6&63]:'=')+(i+2<s.length?chars[b&63]:'=');}return r;};}
if(!window.atob){window.atob=function(s){var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';s=s.replace(/[^A-Za-z0-9+/=]/g,'');var r='';for(var i=0;i<s.length;i+=4){var b=chars.indexOf(s[i])<<18|chars.indexOf(s[i+1])<<12|(s[i+2]!='='?chars.indexOf(s[i+2])<<6:0)|(s[i+3]!='='?chars.indexOf(s[i+3]):0);r+=String.fromCharCode(b>>16&255);if(s[i+2]!='=')r+=String.fromCharCode(b>>8&255);if(s[i+3]!='=')r+=String.fromCharCode(b&255);}return r;};}

/* history pushState intercept */
if(!window.history){window.history={pushState:function(){},replaceState:function(){},go:function(){},back:function(){},forward:function(){},length:1};}
(function(){
  var _push=history.pushState,_rep=history.replaceState;
  function intercept(url){
    if(!url)return;
    var abs;
    try{abs=new URL(url,'${targetUrl}').href;}catch(e){abs=url;}
    if(abs&&abs.indexOf('${proxyBase}')===-1&&/^https?:\/\//.test(abs)){
      window.location.href='${proxyBase}/proxy?url='+encodeURIComponent(abs);
    }
  }
  if(_push)history.pushState=function(s,t,url){intercept(url);try{_push.apply(this,arguments);}catch(e){}};
  if(_rep)history.replaceState=function(s,t,url){intercept(url);try{_rep.apply(this,arguments);}catch(e){}};
  /* popstate */
  window.addEventListener('popstate',function(e){
    var url=location.href;
    if(url&&url.indexOf('${proxyBase}')===-1&&/^https?:\/\//.test(url)){
      window.location.href='${proxyBase}/proxy?url='+encodeURIComponent(url);
    }
  });
})();

/* XHR URL rewrite — ensure AJAX requests go through proxy */
(function(){
  var _XHR_open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method,url,async,user,pass){
    try{
      if(typeof url==='string'&&/^https?:\/\//.test(url)&&url.indexOf('${proxyBase}')===-1){
        url='${proxyBase}/proxy?url='+encodeURIComponent(url);
      }
    }catch(e){}
    _XHR_open.apply(this,[method,url,async!==false,user,pass]);
  };
})();

/* WebSocket stub — 3DS can't do WS anyway */
if(!window.WebSocket){window.WebSocket=function(url){this.url=url;this.readyState=3;};window.WebSocket.prototype={send:function(){},close:function(){},addEventListener:function(){},removeEventListener:function(){}};window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;}

/* ServiceWorker stub */
if(navigator&&!navigator.serviceWorker){try{Object.defineProperty(navigator,'serviceWorker',{get:function(){return{register:function(){return window.Promise.resolve({scope:'/'});},ready:window.Promise.resolve({update:function(){}}),controller:null,addEventListener:function(){}};}});}catch(e){}}

/* AbortController stub */
if(typeof AbortController==='undefined'){window.AbortController=function(){this.signal={aborted:false,addEventListener:function(){},removeEventListener:function(){}};this.abort=function(){this.signal.aborted=true;};}}

/* crypto.randomUUID stub */
if(window.crypto&&!window.crypto.randomUUID){window.crypto.randomUUID=function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:r&0x3|0x8).toString(16);});};}

/* CSS.supports stub */
if(!window.CSS){window.CSS={supports:function(){return false;},escape:function(s){return s;}};}
else if(!window.CSS.supports){window.CSS.supports=function(){return false;};}

/* Dialog element stub */
if(typeof HTMLDialogElement!=='undefined'&&!HTMLDialogElement.prototype.showModal){HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};}

/* Video play() returns Promise stub */
if(typeof HTMLVideoElement!=='undefined'&&HTMLVideoElement.prototype.play){
  var _vplay=HTMLVideoElement.prototype.play;
  HTMLVideoElement.prototype.play=function(){try{var r=_vplay.call(this);if(r&&r.then)return r;return window.Promise.resolve();}catch(e){return window.Promise.resolve();}};
}

/* Pointer events → mouse events */
if(typeof window.PointerEvent==='undefined'){window.PointerEvent=window.MouseEvent||function(){};}
/* Touch events stub */
if(typeof window.TouchEvent==='undefined'){window.TouchEvent=window.Event||function(){};}

/* ===== END SHIMS ===== */
</script>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// §12  VIDEO DETECTION & CONVERSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// Detect YouTube ID from any YouTube URL form
function extractYouTubeId(url) {
  const m = url.match(/(?:youtube\.com\/(?:embed\/|watch\?(?:[^&]*&)*v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Detect Vimeo ID
function extractVimeoId(url) {
  const m = url.match(/(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d+)/);
  return m ? m[1] : null;
}

// Detect Dailymotion ID
function extractDailymotionId(url) {
  const m = url.match(/(?:dailymotion\.com\/(?:embed\/video\/|video\/)|dai\.ly\/)([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Detect Twitch channel/VOD
function extractTwitchInfo(url) {
  const ch  = url.match(/twitch\.tv\/([^/?#]+)/);
  const vod = url.match(/twitch\.tv\/videos\/(\d+)/);
  return vod ? { type:'vod', id: vod[1] } : ch ? { type:'channel', id: ch[1] } : null;
}

// Build a 3DS-compatible video block for a given video source
function buildVideoBlock(proxyBase, { ytId, vmId, dmId, directUrl, posterUrl, label }) {
  const fallbackText = label || 'Video';

  if (ytId) {
    const poster = posterUrl || proxyBase + '/resource?url=' + encodeURIComponent('https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg');
    return (
      '<div class="proxy-video-wrap">' +
      '<video controls preload="none" poster="' + poster + '" width="100%">' +
      '<source src="' + proxyBase + '/video?id=' + encodeURIComponent(ytId) + '&amp;src=youtube" type="video/mp4">' +
      '<p style="color:#fff;padding:8px;font-size:12px;">YouTube video<br>' +
      '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId) + '">' +
      'Watch on YouTube</a></p></video></div>'
    );
  }
  if (vmId) {
    return (
      '<div class="proxy-video-wrap">' +
      '<p style="color:#fff;padding:10px;font-size:12px;text-align:center;">' +
      'Vimeo video (' + vmId + ')<br>' +
      '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent('https://vimeo.com/' + vmId) + '">' +
      'Open on Vimeo</a></p></div>'
    );
  }
  if (dmId) {
    return (
      '<div class="proxy-video-wrap">' +
      '<video controls preload="none" width="100%">' +
      '<source src="' + proxyBase + '/video?id=' + encodeURIComponent(dmId) + '&amp;src=dailymotion" type="video/mp4">' +
      '<p style="color:#fff;padding:8px;font-size:12px;">' +
      '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent('https://www.dailymotion.com/video/' + dmId) + '">' +
      'Watch on Dailymotion</a></p></video></div>'
    );
  }
  if (directUrl) {
    const poster = posterUrl ? ' poster="' + posterUrl + '"' : '';
    return (
      '<div class="proxy-video-wrap">' +
      '<video controls preload="none"' + poster + ' width="100%">' +
      '<source src="' + proxyBase + '/video?url=' + encodeURIComponent(directUrl) + '" type="video/mp4">' +
      '<p style="color:#fff;padding:8px;font-size:12px;">' +
      '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent(directUrl) + '">' +
      'Direct video link</a></p></video></div>'
    );
  }
  return '<div class="proxy-video-wrap"><p style="color:#aaa;padding:10px;">' + fallbackText + ' (unsupported)</p></div>';
}

// ═══════════════════════════════════════════════════════════════════════════════
// §13  HTML TRANSFORM — THE MAIN EVENT
// ═══════════════════════════════════════════════════════════════════════════════

function safeEach($, selector, fn) {
  try { $(selector).each(function() { try { fn.call(this); } catch(e) {} }); } catch(e) {}
}

function transformHTML(html, targetUrl, proxyBase) {

  // ── Pre-clean: strip XML namespace attributes that confuse cheerio ─────────
  html = html.replace(/<[^>]+>/g, tag =>
    tag.replace(/\s[\w-]+:[\w-]+=["'][^"']*["']/g, '')
       .replace(/\s[\w-]+:[\w-]+(?=[\s>\/])/g, '')
  );

  // ── Strip <template> content (can confuse old parsers) ────────────────────
  html = html.replace(/<template[^>]*>[\s\S]*?<\/template>/gi, '');

  // ── Load into cheerio ─────────────────────────────────────────────────────
  const $ = cheerio.load(html, { decodeEntities: false, xmlMode: false });

  // ── Remove hostile meta tags ──────────────────────────────────────────────
  $('meta[name="viewport"]').remove();
  $('meta[http-equiv="X-UA-Compatible"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Content-Type-Options"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('meta[name="theme-color"]').remove();
  $('meta[name="color-scheme"]').remove();

  // ── Remove browser-upgrade scripts ───────────────────────────────────────
  $('script').each(function() {
    const c = $(this).html() || '';
    if (/unsupported.browser|please.upgrade|browserupgrade|outdated.browser|browsehappy|bowser\.js|ua-parser/i.test(c))
      $(this).remove();
  });
  $('noscript').remove();

  // ── Inject shims + corrected viewport ─────────────────────────────────────
  // Ensure <head> exists
  if (!$('head').length) $('html').prepend('<head></head>');
  if (!$('body').length) $('html').append('<body></body>');

  $('head').prepend(
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=2.0">\n' +
    buildShims(proxyBase, targetUrl)
  );

  // ── Rewrite <link rel="stylesheet"> ──────────────────────────────────────
  safeEach($, 'link[rel="stylesheet"]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', proxyBase + '/css?url=' + encodeURIComponent(abs) + '&base=' + encodeURIComponent(abs));
  });

  // ── Remove unsupported link types ─────────────────────────────────────────
  $('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]').remove();
  $('link[rel="manifest"]').remove();
  $('link[rel="preconnect"]').remove();
  $('link[rel="dns-prefetch"]').remove();

  // ── Inline <style> → CSS transform ────────────────────────────────────────
  safeEach($, 'style', function() {
    const raw = $(this).html() || '';
    if (!raw.trim()) return;
    try { $(this).html(transformCSS(raw, targetUrl, proxyBase)); } catch(e) {}
  });

  // ── <script type="module"> → ES5 fallback ─────────────────────────────────
  safeEach($, 'script[type="module"]', function() {
    const src = $(this).attr('src');
    if (src) {
      // Route through /js transform
      $(this).removeAttr('type').attr('src',
        proxyBase + '/js?url=' + encodeURIComponent(resolveUrl(targetUrl, src)) + '&base=' + encodeURIComponent(targetUrl));
    } else {
      $(this).removeAttr('type').html(transformJS($(this).html() || '', proxyBase));
    }
  });
  $('script[type="importmap"]').remove();

  // ── External scripts ───────────────────────────────────────────────────────
  safeEach($, 'script[src]', function() {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:')) return;
    $(this).attr('src', proxyBase + '/js?url=' + encodeURIComponent(resolveUrl(targetUrl, src)) + '&base=' + encodeURIComponent(targetUrl));
  });

  // ── Inline scripts ────────────────────────────────────────────────────────
  safeEach($, 'script:not([src])', function() {
    const t = ($(this).attr('type') || '').toLowerCase();
    if (t && t !== 'text/javascript' && t !== 'application/javascript' && t !== 'module') return;
    $(this).html(transformJS($(this).html() || '', proxyBase));
  });

  // ── Links ─────────────────────────────────────────────────────────────────
  safeEach($, 'a[href]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:') ||
        href.startsWith('mailto:') || href.startsWith('tel:')) return;
    $(this).attr('href', proxyUrl(resolveUrl(targetUrl, href), proxyBase));
  });

  // ── Forms ─────────────────────────────────────────────────────────────────
  safeEach($, 'form', function() {
    const action = $(this).attr('action') || targetUrl;
    const method = ($(this).attr('method') || 'GET').toUpperCase();
    const abs = resolveUrl(targetUrl, action);
    if (method === 'GET') {
      $(this).attr('action', proxyBase + '/form-get');
      $(this).prepend('<input type="hidden" name="__proxy_url" value="' + abs + '">');
    } else {
      $(this).attr('action', proxyBase + '/form-post?url=' + encodeURIComponent(abs));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ── IMAGE HANDLING ───────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────

  // ── <picture> → collapse to best <img> ────────────────────────────────────
  safeEach($, 'picture', function() {
    const pic = $(this);
    let chosenSrc = null;
    // Prefer non-WebP/AVIF/JXL sources
    pic.find('source').each(function() {
      if (chosenSrc) return;
      const type   = ($(this).attr('type') || '').toLowerCase();
      const srcset = $(this).attr('srcset') || $(this).attr('src') || '';
      if (srcset) {
        const firstUrl = srcset.trim().split(/,\s*/)[0].trim().split(/\s+/)[0];
        if (firstUrl) {
          // Prefer jpeg/png/gif over webp/avif in type
          if (/avif|webp|jxl/.test(type)) {
            if (!chosenSrc) chosenSrc = firstUrl; // use as fallback
          } else {
            chosenSrc = firstUrl; // prefer this
          }
        }
      }
    });
    const img = pic.find('img');
    if (!chosenSrc) chosenSrc = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
    if (chosenSrc && !chosenSrc.startsWith('data:')) {
      const abs = resolveUrl(targetUrl, chosenSrc);
      const alt   = img.attr('alt') || '';
      const cls   = img.attr('class') || '';
      // Route modern images through /image endpoint for possible conversion
      const imgSrc = isModernImageFormat(chosenSrc) || /webp|avif/i.test(chosenSrc)
        ? proxyBase + '/image?url=' + encodeURIComponent(abs)
        : proxyBase + '/resource?url=' + encodeURIComponent(abs);
      pic.replaceWith(
        '<img src="' + imgSrc + '"' +
        (alt ? ' alt="' + alt.replace(/"/g, '&quot;') + '"' : '') +
        (cls ? ' class="' + cls.replace(/"/g, '&quot;') + '"' : '') +
        ' style="max-width:100%;height:auto;">'
      );
    } else {
      pic.replaceWith(img);
    }
  });

  // ── Lazy loading — resolve data-src variants ───────────────────────────────
  const lazySrcAttrs = ['data-src','data-lazy-src','data-original','data-lazy','data-srcset','data-img-src','data-url'];
  for (const attr of lazySrcAttrs) {
    safeEach($, 'img[' + attr + ']', function() {
      const lazy = $(this).attr(attr);
      if (!lazy || lazy.startsWith('data:')) return;
      const existing = $(this).attr('src') || '';
      if (!existing || !existing.match(/^https?:/)) $(this).attr('src', resolveUrl(targetUrl, lazy));
      $(this).removeAttr(attr);
    });
  }

  // ── Remove loading/decoding/fetchpriority attributes ──────────────────────
  $('[loading]').removeAttr('loading');
  $('[decoding]').removeAttr('decoding');
  $('[fetchpriority]').removeAttr('fetchpriority');

  // ── Proxy all img src/srcset ──────────────────────────────────────────────
  safeEach($, 'img[src]', function() {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:') || src.startsWith(proxyBase)) return;
    const abs = resolveUrl(targetUrl, src);
    // Check if it's a modern format we can convert
    const needsConvert = /\.(?:webp|avif|jxl)(\?|$)/i.test(abs);
    $(this).attr('src', needsConvert
      ? proxyBase + '/image?url=' + encodeURIComponent(abs)
      : proxyBase + '/resource?url=' + encodeURIComponent(abs)
    );
  });

  safeEach($, 'img[srcset]', function() {
    const srcset = $(this).attr('srcset');
    if (!srcset) return;
    const rewritten = srcset.split(',').map(part => {
      const pieces = part.trim().split(/\s+/);
      const u = pieces[0];
      if (!u || u.startsWith('data:') || u.startsWith(proxyBase)) return part;
      const abs = resolveUrl(targetUrl, u);
      const needsConvert = /\.(?:webp|avif|jxl)(\?|$)/i.test(abs);
      const proxied = needsConvert
        ? proxyBase + '/image?url=' + encodeURIComponent(abs)
        : proxyBase + '/resource?url=' + encodeURIComponent(abs);
      return [proxied, ...pieces.slice(1)].join(' ');
    }).join(', ');
    $(this).attr('srcset', rewritten);
    // Also set src to first entry if no src
    if (!$(this).attr('src') || $(this).attr('src').startsWith('data:')) {
      const first = rewritten.split(',')[0].trim().split(/\s+/)[0];
      if (first) $(this).attr('src', first);
    }
  });

  // ── SVG cleanup — 3DS renders basic SVG but not all features ──────────────
  // Inline SVG: strip filters, clip-paths, foreign objects, animations
  safeEach($, 'svg', function() {
    const svgEl = $(this);
    svgEl.find('filter, clipPath, feColorMatrix, feGaussianBlur, feBlend, feComposite, feFlood, feMerge').remove();
    svgEl.find('animate, animateTransform, animateMotion, set').remove();
    svgEl.find('foreignObject').remove();
    // Remove style attributes with unsupported features
    svgEl.find('[filter]').removeAttr('filter');
    svgEl.find('[clip-path]').removeAttr('clip-path');
    svgEl.find('[mask]').removeAttr('mask');
  });

  // ── <canvas> — add a notice if it's for video/complex rendering ──────────
  safeEach($, 'canvas', function() {
    const w = parseInt($(this).attr('width') || '0');
    const h = parseInt($(this).attr('height') || '0');
    if (w > 200 || h > 200) {
      // Large canvas is likely used for video or heavy graphics
      $(this).after('<p style="font-size:11px;color:#666;">[Canvas element — may not render on 3DS]</p>');
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ── VIDEO HANDLING — THE DEEP END ────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────

  // ── <iframe> — detect and replace video embeds ────────────────────────────
  safeEach($, 'iframe[src]', function() {
    const src = $(this).attr('src') || $(this).attr('data-src') || '';
    if (!src || src.startsWith('javascript:')) return;
    const abs = resolveUrl(targetUrl, src);

    const ytId = extractYouTubeId(abs);
    const vmId = extractVimeoId(abs);
    const dmId = extractDailymotionId(abs);
    const twitch = extractTwitchInfo(abs);

    if (ytId) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { ytId }));
    } else if (vmId) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { vmId }));
    } else if (dmId) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { dmId }));
    } else if (twitch) {
      $(this).replaceWith(
        '<div class="proxy-video-wrap">' +
        '<p style="color:#fff;padding:10px;font-size:12px;text-align:center;">' +
        'Twitch stream: ' + twitch.id + '<br>' +
        '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent('https://www.twitch.tv/' + twitch.id) + '">' +
        'Open Twitch page</a></p></div>'
      );
    } else if (/facebook\.com\/plugins\/video|fb\.watch/.test(abs)) {
      const fbUrl = abs.match(/href=([^&]+)/);
      const link  = fbUrl ? decodeURIComponent(fbUrl[1]) : abs;
      $(this).replaceWith(
        '<div class="proxy-video-wrap">' +
        '<p style="color:#fff;padding:10px;font-size:12px;">Facebook video<br>' +
        '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent(link) + '">' +
        'Open on Facebook</a></p></div>'
      );
    } else if (/instagram\.com\/p\//.test(abs)) {
      $(this).replaceWith(
        '<div class="proxy-video-wrap">' +
        '<p style="color:#fff;padding:10px;font-size:12px;">Instagram embed<br>' +
        '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">' +
        'Open on Instagram</a></p></div>'
      );
    } else if (/tiktok\.com/.test(abs)) {
      $(this).replaceWith(
        '<div class="proxy-video-wrap">' +
        '<p style="color:#fff;padding:10px;font-size:12px;">TikTok video<br>' +
        '<a style="color:#8cf;" href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">' +
        'Open on TikTok</a></p></div>'
      );
    } else if (/spotify\.com\/embed/.test(abs)) {
      $(this).replaceWith(
        '<p style="font-size:12px;">[Spotify embed] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open Spotify</a></p>'
      );
    } else if (/soundcloud\.com/.test(abs)) {
      $(this).replaceWith(
        '<p style="font-size:12px;">[SoundCloud player] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open SoundCloud</a></p>'
      );
    } else if (/bandcamp\.com/.test(abs)) {
      $(this).replaceWith(
        '<p style="font-size:12px;">[Bandcamp player] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open Bandcamp</a></p>'
      );
    } else if (/google\.com\/maps/.test(abs) || /maps\.google/.test(abs)) {
      // Google Maps iframe → just a link
      $(this).replaceWith(
        '<p style="font-size:12px;">[Google Maps embed] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open Map</a></p>'
      );
    } else if (/twitter\.com\/.*\/status|x\.com\/.*\/status/.test(abs)) {
      $(this).replaceWith(
        '<p style="font-size:12px;">[Tweet embed] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">View Tweet</a></p>'
      );
    } else {
      // Generic iframe — proxy through
      $(this).attr('src', proxyUrl(abs, proxyBase));
      // Strip sandbox — blocks things on old WebKit
      $(this).removeAttr('sandbox');
      $(this).removeAttr('allow');
      $(this).removeAttr('allowfullscreen');
    }
  });

  // ── <video> elements ──────────────────────────────────────────────────────
  safeEach($, 'video', function() {
    const videoEl = $(this);
    let src = videoEl.attr('src') || '';

    // Check for YouTube/etc in src attribute
    if (src) {
      const ytId = extractYouTubeId(src);
      if (ytId) {
        videoEl.replaceWith(buildVideoBlock(proxyBase, { ytId }));
        return;
      }
    }

    // Gather sources from <source> children
    const sources = [];
    videoEl.find('source').each(function() {
      const s = $(this).attr('src') || '';
      const t = $(this).attr('type') || '';
      if (s && !s.startsWith('data:')) sources.push({ src: s, type: t });
    });

    // Pick best source: prefer MP4 over WebM/OGV
    let bestSrc = src;
    if (!bestSrc && sources.length) {
      bestSrc = (sources.find(s => /mp4|h264|avc/i.test(s.type + s.src)) || sources[0]).src;
    }

    const poster = videoEl.attr('poster') || '';

    if (bestSrc && !bestSrc.startsWith('data:')) {
      const abs = resolveUrl(targetUrl, bestSrc);
      const proxiedPoster = poster && !poster.startsWith('data:')
        ? proxyBase + '/resource?url=' + encodeURIComponent(resolveUrl(targetUrl, poster))
        : '';
      // Detect HLS/DASH
      if (/\.m3u8(\?|$)/i.test(abs) || /\.mpd(\?|$)/i.test(abs)) {
        // HLS/DASH — can't play natively on 3DS; offer a download link
        videoEl.replaceWith(
          '<div class="proxy-video-wrap">' +
          (proxiedPoster ? '<img src="' + proxiedPoster + '" style="max-width:100%;height:auto;">' : '') +
          '<p style="color:#fff;padding:8px;font-size:12px;">Streaming video (HLS/DASH)<br>' +
          '<a style="color:#8cf;" href="' + proxyBase + '/video?url=' + encodeURIComponent(abs) + '">Try to play</a></p></div>'
        );
        return;
      }
      // Regular video
      const proxiedSrc  = proxyBase + '/video?url=' + encodeURIComponent(abs);
      const posterAttr  = proxiedPoster ? ' poster="' + proxiedPoster + '"' : '';
      videoEl.replaceWith(
        '<div class="proxy-video-wrap">' +
        '<video controls preload="none"' + posterAttr + ' width="100%">' +
        '<source src="' + proxiedSrc + '" type="video/mp4">' +
        '<p style="color:#fff;padding:8px;font-size:12px;">' +
        '<a style="color:#8cf;" href="' + proxiedSrc + '">Download video</a></p></video></div>'
      );
    } else if (!bestSrc) {
      // No src found at all
      videoEl.replaceWith('<div class="proxy-video-wrap"><p style="color:#aaa;padding:8px;">[Video unavailable]</p></div>');
    } else {
      // data: URI video — remove (3DS can't handle large data URIs)
      videoEl.replaceWith('<p style="font-size:11px;color:#666;">[Inline video removed]</p>');
    }
  });

  // ── <audio> elements ──────────────────────────────────────────────────────
  safeEach($, 'audio', function() {
    const audioEl = $(this);
    let src = audioEl.attr('src') || '';
    if (!src) {
      audioEl.find('source').each(function() {
        if (!src) src = $(this).attr('src') || '';
      });
    }
    if (src && !src.startsWith('data:')) {
      const abs = resolveUrl(targetUrl, src);
      const proxied = proxyBase + '/audio?url=' + encodeURIComponent(abs);
      audioEl.replaceWith(
        '<div class="proxy-audio-wrap">' +
        '<audio controls preload="none" style="width:100%;max-width:400px;">' +
        '<source src="' + proxied + '" type="audio/mpeg">' +
        '<a href="' + proxied + '">Download audio</a>' +
        '</audio></div>'
      );
    }
  });

  // ── <object> and <embed> — Flash, video, etc. ─────────────────────────────
  safeEach($, 'object[data]', function() {
    const data  = $(this).attr('data') || '';
    const type  = $(this).attr('type') || '';
    const abs   = resolveUrl(targetUrl, data);
    const ytId  = extractYouTubeId(abs);
    if (ytId) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { ytId }));
    } else if (/video|flash|swf|mp4|webm/i.test(type + data)) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { directUrl: abs, label: 'Object/Flash video' }));
    } else {
      $(this).replaceWith(
        '<p style="font-size:12px;">[Object: ' + (type||data).substring(0,60) + '] ' +
        '<a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open</a></p>'
      );
    }
  });

  safeEach($, 'embed[src]', function() {
    const src  = $(this).attr('src') || '';
    const type = $(this).attr('type') || '';
    const abs  = resolveUrl(targetUrl, src);
    const ytId = extractYouTubeId(abs);
    if (ytId) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { ytId }));
    } else if (/video|flash|swf|mp4|webm/i.test(type + src)) {
      $(this).replaceWith(buildVideoBlock(proxyBase, { directUrl: abs, label: 'Embed video' }));
    } else {
      $(this).replaceWith(
        '<p style="font-size:12px;">[Embed] <a href="' + proxyBase + '/proxy?url=' + encodeURIComponent(abs) + '">Open</a></p>'
      );
    }
  });

  // ── Inline style attribute → CSS downgrade ────────────────────────────────
  safeEach($, '[style]', function() {
    const style = $(this).attr('style') || '';
    const outDecls = [];
    for (const part of style.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon < 0) continue;
      let iprop = trimmed.slice(0, colon).trim().toLowerCase();
      let ival  = trimmed.slice(colon + 1).trim();
      // Proxy url() in inline styles
      ival = ival.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
        if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('about:')) return match;
        return "url('" + proxyBase + '/resource?url=' + encodeURIComponent(resolveUrl(targetUrl, u)) + "')";
      });
      const fakeDecl = { type:'declaration', property: iprop, value: ival };
      try {
        for (const r of downgradeCSSProperty(fakeDecl, {}))
          if (r && r.property && r.value) outDecls.push(r.property + ':' + r.value);
      } catch(e) {
        outDecls.push(iprop + ':' + ival);
      }
    }
    $(this).attr('style', outDecls.join(';'));
  });

  // ── Proxy remaining resource src attributes ───────────────────────────────
  const srcAttrs = [
    ['source[src]',                    'src'],
    ['track[src]',                     'src'],
    ['input[type="image"]',            'src'],
    ['link[rel="icon"]',               'href'],
    ['link[rel="shortcut icon"]',      'href'],
    ['link[rel="apple-touch-icon"]',   'href'],
    ['link[rel="apple-touch-icon-precomposed"]', 'href'],
  ];
  for (const [sel, attr] of srcAttrs) {
    safeEach($, sel, function() {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:') || val.startsWith(proxyBase)) return;
      $(this).attr(attr, proxyBase + '/resource?url=' + encodeURIComponent(resolveUrl(targetUrl, val)));
    });
  }

  // ── Background images in data-bg / data-background attributes ─────────────
  for (const attr of ['data-bg','data-background','data-background-image','data-cover']) {
    safeEach($, '[' + attr + ']', function() {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:')) return;
      $(this).attr(attr, proxyBase + '/resource?url=' + encodeURIComponent(resolveUrl(targetUrl, val)));
    });
  }

  // ── <details> / <summary> — add basic open behaviour ────────────────────
  // Old WebKit doesn't support <details>; script the toggle manually
  safeEach($, 'details', function() {
    const det = $(this);
    const id  = 'det_' + Math.random().toString(36).slice(2,8);
    det.attr('id', id);
    const sum = det.find('summary').first();
    if (sum.length) {
      sum.attr('onclick', 'var d=document.getElementById("' + id + '");d.open=!d.open;this.setAttribute("data-open",d.open);');
      sum.attr('style', (sum.attr('style')||'') + ';cursor:pointer;font-weight:bold;');
    }
  });

  // ── Favicon references ─────────────────────────────────────────────────────
  safeEach($, 'link[rel*="icon"]', function() {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:') || href.startsWith(proxyBase)) return;
    $(this).attr('href', proxyBase + '/resource?url=' + encodeURIComponent(resolveUrl(targetUrl, href)));
  });

  // ── Web components — strip shadow DOM / custom element definitions ─────────
  safeEach($, '[is]', function() { $(this).removeAttr('is'); });

  // ── Remove dialog elements (not supported on 3DS WebKit) ──────────────────
  // Convert to div with border
  safeEach($, 'dialog', function() {
    $(this).replaceWith('<div style="border:2px solid #333;padding:10px;background:#fff;margin:10px 0;">' + $(this).html() + '</div>');
  });

  // ── Decode HTML entities in attribute hrefs that got double-encoded ────────
  // (some CMSes produce href="&amp;amp;" etc.)
  safeEach($, 'a[href]', function() {
    let href = $(this).attr('href') || '';
    if (href.includes('&amp;amp;')) {
      href = href.replace(/&amp;/g, '&');
      $(this).attr('href', href);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ── RECOVERY STYLESHEET — injected LAST so it wins specificity wars ───────
  // ─────────────────────────────────────────────────────────────────────────
  $('body').append(`<style>
/* ── 3DS Proxy Recovery Stylesheet v2 ─────────────────────────────────── */

/* Box model reset */
*{-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box;}
html,body{width:100%!important;max-width:100%!important;overflow-x:hidden!important;
  margin:0!important;padding:0!important;word-wrap:break-word;word-break:break-word;}
body{padding:6px!important;line-height:1.5;background:#fff;color:#222;}

/* Typography */
body,input,select,textarea,button{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222;}
h1{font-size:20px;margin:10px 0 6px;}h2{font-size:17px;margin:9px 0 5px;}
h3{font-size:15px;margin:8px 0 4px;}h4,h5,h6{font-size:13px;margin:6px 0 3px;}
h1,h2,h3,h4,h5,h6{line-height:1.3;font-weight:bold;}p{margin:6px 0;}

/* Links */
a{color:#0055cc;text-decoration:underline;}a:visited{color:#551a8b;}
a:hover,a:focus{color:#0033aa;}

/* Images & media */
img,video,canvas,svg{max-width:100%!important;height:auto!important;display:inline-block;}
img{vertical-align:middle;}figure{margin:6px 0;}figcaption{font-size:11px;color:#555;margin-top:2px;}

/* Tables */
table{width:100%!important;max-width:100%!important;border-collapse:collapse;
  word-wrap:break-word;table-layout:fixed;margin:6px 0;}
td,th{word-wrap:break-word;overflow:hidden;padding:4px 5px;
  border:1px solid #ddd;vertical-align:top;text-align:left;}
th{background:#f0f0f0;font-weight:bold;}
tr:nth-child(even) td{background:#f9f9f9;}
/* Wide tables — allow horizontal scroll */
.proxy-table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;width:100%;}

/* Code */
pre,code,kbd,samp{white-space:pre-wrap!important;word-wrap:break-word!important;
  max-width:100%!important;font-family:monospace;font-size:11px;}
pre{background:#f4f4f4;border:1px solid #ddd;padding:6px;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;overflow-x:auto;}
code{background:#f0f0f0;padding:1px 3px;-webkit-border-radius:2px;border-radius:2px;}
pre code{background:none;padding:0;}

/* Forms */
input,select,textarea,button{max-width:100%!important;font-size:13px;
  -webkit-box-sizing:border-box;box-sizing:border-box;}
input[type=text],input[type=search],input[type=email],input[type=url],
input[type=password],input[type=number],input[type=tel],input[type=date],
textarea,select{
  display:inline-block;padding:5px 6px;border:1px solid #aaa;
  -webkit-border-radius:3px;border-radius:3px;background:#fff;
  width:auto;max-width:100%;vertical-align:middle;}
input[type=submit],input[type=button],input[type=reset],button,[type=submit]{
  display:inline-block;padding:5px 12px;cursor:pointer;
  background:#e8e8e8;border:1px solid #aaa;
  -webkit-border-radius:3px;border-radius:3px;
  color:#222;font-size:13px;text-align:center;}
input[type=submit]:active,button:active{background:#d0d0d0;}
label{display:inline-block;margin-bottom:2px;}
fieldset{border:1px solid #bbb;padding:6px;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;}
legend{font-weight:bold;padding:0 4px;}
input[type=checkbox],input[type=radio]{width:auto;margin-right:4px;}
input[type=range]{width:100%;}

/* Lists */
ul,ol{padding-left:22px;margin:6px 0;}li{margin:2px 0;}
dl{margin:6px 0;}dt{font-weight:bold;}dd{margin-left:16px;margin-bottom:3px;}

/* Blockquote & HR */
blockquote{margin:8px 4px;padding:4px 10px;border-left:3px solid #aaa;color:#444;background:#f8f8f8;}
hr{border:0;border-top:1px solid #ccc;margin:10px 0;}

/* Position fixes — fixed causes viewport issues on 3DS */
[style*="position:fixed"],[style*="position: fixed"]{position:absolute!important;}
/* Sticky headers keep their stickiness */
[style*="position:sticky"],[style*="position: sticky"]{position:-webkit-sticky!important;position:sticky!important;}

/* Nav */
nav ul,nav ol{padding:0;margin:0;list-style:none;}
nav li{display:inline-block;margin:0 4px 4px 0;}
nav li a{padding:3px 8px;text-decoration:none;background:#eee;
  display:inline-block;-webkit-border-radius:3px;border-radius:3px;}

/* Cards and panels */
[class*="card"],[class*="panel"],[class*="tile"],[class*="box"]{
  border:1px solid #ddd;padding:8px;margin:6px 0;background:#fff;
  -webkit-border-radius:4px;border-radius:4px;display:block;}

/* Buttons with class names */
[class*="btn"],[class*="button"]{
  display:inline-block!important;padding:5px 12px!important;
  border:1px solid #aaa!important;-webkit-border-radius:3px!important;
  border-radius:3px!important;background:#e8e8e8!important;
  color:#222!important;text-decoration:none!important;
  font-size:13px!important;cursor:pointer!important;}

/* Badges, tags */
[class*="badge"],[class*="tag"],[class*="pill"],[class*="chip"]{
  display:inline-block;padding:2px 7px;-webkit-border-radius:10px;
  border-radius:10px;background:#ddd;color:#333;font-size:11px;
  border:1px solid #bbb;margin:1px;}

/* Hero / banner */
[class*="hero"],[class*="banner"],[class*="jumbotron"]{
  padding:12px 8px!important;margin:0 0 8px!important;}

/* Dark mode reset */
[class*="dark"],[class*="theme-dark"]{color:#222!important;background:#f5f5f5!important;}

/* Grid/flex container recovery */
[class*="flex"],[class*="grid"],[class*="row"],[class*="columns"]{overflow:hidden;}
[class*="flex"] > *,[class*="grid"] > *,[class*="row"] > *{max-width:100%;word-wrap:break-word;}

/* Collapse multi-column to single */
[class*="col-"],[class*="column"]{width:100%!important;max-width:100%!important;
  float:none!important;display:block!important;}

/* Modals and overlays — make them scrollable not fixed */
[class*="modal"],[class*="overlay"],[class*="dialog"],[class*="popup"]{
  position:relative!important;top:auto!important;left:auto!important;
  width:100%!important;max-width:100%!important;
  height:auto!important;max-height:none!important;
  -webkit-transform:none!important;transform:none!important;
  margin:10px auto!important;
  border:2px solid #aaa;-webkit-border-radius:4px;border-radius:4px;
  background:#fff;padding:10px;overflow:visible!important;}

/* Sidebars become top-of-page blocks */
[class*="sidebar"],[class*="aside"],[class*="widget-area"]{
  width:100%!important;max-width:100%!important;float:none!important;
  display:block!important;margin:0 0 8px!important;}

/* Sticky bars */
[class*="sticky"],[class*="fixed-top"],[class*="navbar-fixed"]{
  position:relative!important;}

/* Tooltips / popovers → hide */
[class*="tooltip"],[class*="popover"],[role="tooltip"]{display:none!important;}

/* Fluid video container (the crown jewel) */
.proxy-video-wrap{
  position:relative;width:100%;padding-bottom:56.25%;height:0;
  overflow:hidden;background:#111;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;}
.proxy-video-wrap video,.proxy-video-wrap iframe{
  position:absolute;top:0;left:0;width:100%!important;height:100%!important;border:0;}
.proxy-video-wrap p{position:absolute;top:50%;left:0;width:100%;
  -webkit-transform:translateY(-50%);transform:translateY(-50%);text-align:center;}
.proxy-video-wrap img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;}

/* Audio player */
.proxy-audio-wrap{margin:6px 0;padding:4px 0;}

/* Spinner/loader elements → hide */
[class*="spinner"],[class*="loader"],[class*="loading"]{
  display:none!important;}

/* Progress bars — make them visible */
progress,[class*="progress"]{
  width:100%!important;height:16px;display:block;margin:4px 0;
  background:#ddd;border:1px solid #bbb;-webkit-border-radius:8px;border-radius:8px;overflow:hidden;}

/* Details/summary */
details{border:1px solid #ccc;padding:4px 8px;margin:4px 0;-webkit-border-radius:3px;border-radius:3px;}
summary{cursor:pointer;font-weight:bold;padding:4px 0;}

/* Iframe generic */
iframe{max-width:100%!important;border:1px solid #ccc;}

/* Skip-to-content links */
[class*="skip-link"],[class*="screen-reader"]{position:absolute;left:-9999px;}

/* Selection highlight */
::-webkit-selection{background:#b3d4fd;color:#000;}
::-moz-selection{background:#b3d4fd;color:#000;}

/* Narrow-screen tweaks for 3DS top screen (320px) */
@media screen and (max-width:340px){
  body{font-size:12px!important;padding:3px!important;}
  h1{font-size:16px;}h2{font-size:14px;}h3,h4,h5,h6{font-size:12px;}
  td,th{font-size:11px;padding:2px 3px;}
  input,select,textarea,button{font-size:12px;}
  pre,code{font-size:10px;}
  [class*="btn"],[class*="button"]{padding:4px 8px!important;font-size:12px!important;}
  nav li a{padding:2px 5px;font-size:12px;}
  .proxy-video-wrap{padding-bottom:75%;} /* taller ratio on small screen */
}
</style>`);

  return $.html();
}

// ═══════════════════════════════════════════════════════════════════════════════
// §14  EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── HOME ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3DS Proxy</title>
<style>
body{font-family:Arial,sans-serif;padding:10px;background:#dde;width:100%;max-width:600px;margin:0 auto;-webkit-box-sizing:border-box;box-sizing:border-box;}
h2{color:#336;font-size:16px;margin:0 0 8px;}
form{margin-bottom:8px;}
input[name=q]{width:72%;padding:4px;font-size:13px;border:1px solid #888;-webkit-border-radius:3px;border-radius:3px;}
input[type=submit]{padding:4px 10px;font-size:13px;background:#e0e0ff;border:1px solid #88a;-webkit-border-radius:3px;border-radius:3px;}
small{color:#555;font-size:11px;}
.tip{background:#fff;border:1px solid #aac;padding:5px 8px;margin:6px 0;font-size:11px;-webkit-border-radius:3px;border-radius:3px;}
@media screen and (max-width:340px){input[name=q]{width:62%;font-size:12px;}}
</style>
</head><body>
<h2>3DS Web Proxy</h2>
<form method="GET" action="/go">
<input name="q" placeholder="URL or search term" autocomplete="off">
<input type="submit" value="Go">
</form>
<div class="tip">Type a URL like <b>example.com</b> or any search query.<br>
Search powered by DuckDuckGo Lite.</div>
<small>Negative passthrough mode: everything converts, nothing blocked outright.</small>
</body></html>`);
});

// ── SMART GO ──────────────────────────────────────────────────────────────────
app.get('/go', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');
  if (/^https?:\/\//i.test(q) || /^[\w-]+\.\w{2,}(\/|$)/.test(q))
    return res.redirect('/proxy?url=' + encodeURIComponent(/^https?:\/\//i.test(q) ? q : 'http://' + q));
  return res.redirect('/search?q=' + encodeURIComponent(q));
});

// ── /ask shortcut ─────────────────────────────────────────────────────────────
app.get('/ask', (req, res) =>
  res.redirect('/search?q=' + encodeURIComponent(req.query.q || req.query.query || '')));

// ── PROXY — main passthrough ─────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  let targetUrl = (req.query.url || '').trim();
  if (!targetUrl) return res.redirect('/');
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'http://' + targetUrl;
  const proxyBase = req.protocol + '://' + req.get('host');

  try {
    const response = await proxyFetch(targetUrl);

    // Follow redirects manually
    if (response.status >= 300 && response.status < 400 && response.headers.location)
      return res.redirect('/proxy?url=' + encodeURIComponent(resolveUrl(targetUrl, response.headers.location)));

    const ct = (response.headers['content-type'] || '').toLowerCase();

    if (ct.includes('text/html') || ct.includes('application/xhtml')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      let bodyStr;
      try { bodyStr = response.data.toString('utf-8'); } catch { bodyStr = ''; }
      try { res.send(transformHTML(bodyStr, targetUrl, proxyBase)); }
      catch(e) { res.send('<!-- transform error: ' + e.message + ' -->\n' + bodyStr); }

    } else if (ct.includes('text/css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.send(transformCSS(response.data.toString('utf-8'), targetUrl, proxyBase));

    } else if (ct.includes('javascript') || ct.includes('ecmascript')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.send(transformJS(response.data.toString('utf-8'), proxyBase));

    } else if (ct.includes('video/') || ct.includes('application/x-mpegurl') ||
               ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/dash+xml')) {
      // Route video through video proxy
      return res.redirect('/video?url=' + encodeURIComponent(targetUrl));

    } else if (ct.includes('audio/')) {
      return res.redirect('/audio?url=' + encodeURIComponent(targetUrl));

    } else if (ct.includes('image/') && isModernImageFormat(ct)) {
      // Convert modern image formats
      return res.redirect('/image?url=' + encodeURIComponent(targetUrl));

    } else if (ct.includes('application/json')) {
      // JSON — might be used directly by scripts; return as-is
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(response.data);

    } else if (ct.includes('text/plain') || ct.includes('text/xml') || ct.includes('application/xml')) {
      res.setHeader('Content-Type', ct + '; charset=utf-8');
      res.send(response.data.toString('utf-8'));

    } else {
      // Binary passthrough
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(response.data);
    }

  } catch(err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<html><body><h3>Proxy error</h3><p>' + err.message + '</p>' +
      '<p><a href="/">Home</a></p></body></html>');
  }
});

// ── CSS endpoint ──────────────────────────────────────────────────────────────
app.get('/css', async (req, res) => {
  if (!req.query.url) return res.send('');
  const proxyBase = req.protocol + '://' + req.get('host');
  try {
    const r = await axios.get(req.query.url, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 12000, validateStatus: () => true,
      responseType: 'arraybuffer'
    });
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(transformCSS(r.data.toString('utf-8'), req.query.base || req.query.url, proxyBase));
  } catch { res.send('/* css fetch failed */'); }
});

// ── JS endpoint ───────────────────────────────────────────────────────────────
app.get('/js', async (req, res) => {
  if (!req.query.url) return res.send('');
  const proxyBase = req.protocol + '://' + req.get('host');
  try {
    const r = await axios.get(req.query.url, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 12000, validateStatus: () => true,
      responseType: 'arraybuffer'
    });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(transformJS(r.data.toString('utf-8'), proxyBase));
  } catch { res.send('/* js fetch failed */'); }
});

// ── IMAGE endpoint — WebP/AVIF → JPEG conversion ─────────────────────────────
app.get('/image', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.end();

  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': MODERN_UA, 'Accept': 'image/*,*/*;q=0.8' },
      responseType: 'arraybuffer',
      timeout: 15000,
      validateStatus: () => true,
      maxContentLength: 10 * 1024 * 1024
    });

    const ct = (r.headers['content-type'] || '').toLowerCase();

    if (sharp && isModernImageFormat(ct)) {
      // Convert WebP/AVIF to JPEG via sharp
      try {
        const jpeg = await sharp(r.data)
          .flatten({ background: { r: 255, g: 255, b: 255 } }) // handle transparency
          .jpeg({ quality: IMAGE_QUALITY, progressive: false })
          .toBuffer();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(jpeg);
      } catch(e) {
        console.warn('[proxy/image] sharp conversion failed:', e.message);
        // Fall through to raw pass
      }
    }

    // Passthrough (including already-JPEG/PNG)
    res.setHeader('Content-Type', ct || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.data);

  } catch(e) {
    // Return a tiny 1x1 transparent GIF as fallback
    const gif1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.send(gif1x1);
  }
});

// ── RESOURCE endpoint — generic binary passthrough ────────────────────────────
app.get('/resource', async (req, res) => {
  if (!req.query.url) return res.end();
  const url = req.query.url;
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': MODERN_UA, 'Accept': '*/*' },
      timeout: 15000,
      validateStatus: () => true,
      maxContentLength: 20 * 1024 * 1024
    });
    const ct = r.headers['content-type'] || 'application/octet-stream';
    // If the resource turned out to be a modern image format, redirect to /image
    if (isModernImageFormat(ct)) {
      return res.redirect('/image?url=' + encodeURIComponent(url));
    }
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch { res.end(); }
});

// ── AUDIO endpoint ────────────────────────────────────────────────────────────
// Streams audio. If ffmpeg is available and format is not MP3/WAV, transcode.
app.get('/audio', async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).end();

  try {
    const range   = req.headers['range'];
    const headers = { 'User-Agent': MODERN_UA };
    if (range) headers['Range'] = range;

    if (ffmpeg && !/mp3|wav|mpeg/i.test(url)) {
      // Transcode to MP3
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const cmd = ffmpeg(url)
        .format('mp3')
        .audioBitrate(128)
        .audioChannels(1)
        .on('error', err => { console.warn('[audio] ffmpeg error:', err.message); if (!res.headersSent) res.end(); });
      cmd.pipe(res);
      return;
    }

    // Passthrough
    const upstream = await axios.get(url, {
      responseType: 'stream', headers, timeout: 30000,
      validateStatus: () => true, maxRedirects: 5
    });
    const ct = upstream.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (upstream.headers['content-length'])  res.setHeader('Content-Length',  upstream.headers['content-length']);
    if (upstream.headers['content-range'])   res.setHeader('Content-Range',   upstream.headers['content-range']);
    res.status(upstream.status === 206 ? 206 : 200);
    upstream.data.pipe(res);

  } catch(err) {
    res.status(500).send('<html><body><h3>Audio error</h3><p>' + err.message + '</p></body></html>');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// §15  VIDEO ENDPOINT — the most complex route
// ═══════════════════════════════════════════════════════════════════════════════
//
//  Handles:
//   /video?id=<ytId>&src=youtube       — YouTube via ytdl-core
//   /video?id=<dmId>&src=dailymotion   — Dailymotion API
//   /video?url=<directUrl>             — Direct video, optionally transcoded
//   /video?url=<hlsUrl>                — HLS manifest (M3U8) — fetch first segment
//
// The 3DS supports H.264 Baseline in an MP4 container at up to 240p.
// We attempt to serve that, using ffmpeg transcoding when available.

app.get('/video', async (req, res) => {
  const directUrl = (req.query.url || '').trim();
  const id        = (req.query.id  || '').trim();
  const src       = (req.query.src || '').toLowerCase();

  // ── Error helper ────────────────────────────────────────────────────────
  const videoError = (msg, code) => {
    res.status(code || 500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<html><body><h3>Video error</h3><p>' + msg + '</p><a href="/">Back</a></body></html>');
  };

  try {
    // ────────────────────────────────────────────────────────────────────
    // YouTube via ytdl-core
    // ────────────────────────────────────────────────────────────────────
    if (src === 'youtube' && id) {
      if (!ytdl) {
        return videoError('YouTube streaming requires <b>ytdl-core</b>.<br>Run: <code>npm install ytdl-core</code>', 503);
      }
      const videoUrl = 'https://www.youtube.com/watch?v=' + id;
      const info     = await ytdl.getInfo(videoUrl);

      // Prefer combined H.264 MP4 at ≤240p, fall back to lowest available
      let format = null;
      const preferOrder = ['144p','240p','360p','480p','small'];
      for (const ql of preferOrder) {
        try {
          format = ytdl.chooseFormat(info.formats, {
            quality: ql,
            filter: f => f.hasVideo && f.hasAudio && (f.container === 'mp4') && f.videoCodec && /avc/.test(f.videoCodec)
          });
          if (format) break;
        } catch {}
      }
      if (!format) {
        try { format = ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' }); } catch {}
      }
      if (!format) {
        // Last resort: separate streams (no audio/video merge without ffmpeg)
        format = info.formats.filter(f => f.hasVideo)[0] || info.formats[0];
      }

      if (ffmpeg && format) {
        // Transcode to 3DS-friendly MP4 on the fly
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const ytStream = ytdl(videoUrl, { format });
        const cmd = ffmpeg(ytStream)
          .videoCodec('libx264')
          .addOption('-profile:v', 'baseline')
          .addOption('-level', '3.0')
          .addOption('-vf', 'scale=-2:' + VIDEO_MAX_HEIGHT)
          .videoBitrate('300k')
          .audioCodec('aac')
          .audioBitrate('64k')
          .audioChannels(1)
          .audioFrequency(22050)
          .format('mp4')
          .addOption('-movflags', 'frag_keyframe+empty_moov+faststart')
          .on('error', err => { console.warn('[video/yt] ffmpeg error:', err.message); try { res.end(); } catch {} });
        cmd.pipe(res);
      } else if (format) {
        // Stream directly
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        ytdl(videoUrl, { format }).pipe(res);
      } else {
        return videoError('No compatible YouTube format found.');
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────
    // Dailymotion — fetch metadata, redirect to lowest quality stream
    // ────────────────────────────────────────────────────────────────────
    if (src === 'dailymotion' && id) {
      const apiUrl = 'https://www.dailymotion.com/player/metadata/video/' + id;
      let streamUrl = null;
      try {
        const meta = await axios.get(apiUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 10000, validateStatus: () => true });
        if (meta.data && meta.data.qualities) {
          for (const p of ['144','240','380','480','auto']) {
            const bucket = meta.data.qualities[p];
            if (bucket && bucket[0] && bucket[0].url) { streamUrl = bucket[0].url; break; }
          }
        }
      } catch(e) { console.warn('[video/dm] metadata fetch failed:', e.message); }

      if (!streamUrl) return videoError('Dailymotion stream not found.', 404);

      if (ffmpeg) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const cmd = ffmpeg(streamUrl)
          .videoCodec('libx264')
          .addOption('-profile:v', 'baseline')
          .addOption('-level', '3.0')
          .addOption('-vf', 'scale=-2:' + VIDEO_MAX_HEIGHT)
          .videoBitrate('300k')
          .audioCodec('aac')
          .audioBitrate('64k')
          .audioChannels(1)
          .format('mp4')
          .addOption('-movflags', 'frag_keyframe+empty_moov')
          .on('error', err => { console.warn('[video/dm] ffmpeg error:', err.message); try { res.end(); } catch {} });
        cmd.pipe(res);
      } else {
        return res.redirect(streamUrl);
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────
    // Direct video URL
    // ────────────────────────────────────────────────────────────────────
    if (directUrl) {
      const range   = req.headers['range'];
      const headers = { 'User-Agent': MODERN_UA, 'Accept': 'video/*, */*' };
      if (range) headers['Range'] = range;

      // ── HLS / DASH manifest ─────────────────────────────────────────
      if (/\.m3u8(\?|$)/i.test(directUrl) || /\.mpd(\?|$)/i.test(directUrl)) {
        if (ffmpeg) {
          // Transcode HLS/DASH to fragmented MP4 stream
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Cache-Control', 'no-cache');
          const cmd = ffmpeg(directUrl)
            .inputOptions(['-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto'])
            .videoCodec('libx264')
            .addOption('-profile:v', 'baseline')
            .addOption('-level', '3.0')
            .addOption('-vf', 'scale=-2:' + VIDEO_MAX_HEIGHT)
            .videoBitrate('300k')
            .audioCodec('aac')
            .audioBitrate('64k')
            .audioChannels(1)
            .format('mp4')
            .addOption('-movflags', 'frag_keyframe+empty_moov+faststart')
            .on('error', err => { console.warn('[video/hls] ffmpeg error:', err.message); try { res.end(); } catch {} });
          cmd.pipe(res);
          return;
        }
        // No ffmpeg — try fetching the master playlist and redirecting to first segment
        try {
          const m3u8 = await axios.get(directUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 8000 });
          const lines = m3u8.data.toString().split('\n');
          // Find first media URI (non-comment, non-empty)
          const segment = lines.find(l => l.trim() && !l.startsWith('#'));
          if (segment) {
            const segUrl = resolveUrl(directUrl, segment.trim());
            return res.redirect('/video?url=' + encodeURIComponent(segUrl));
          }
        } catch {}
        return videoError('HLS streaming requires ffmpeg. Install fluent-ffmpeg + ffmpeg-static.', 503);
      }

      // ── Decide whether to transcode ─────────────────────────────────
      const needsTranscode = ffmpeg && (
        /\.webm(\?|$)/i.test(directUrl) ||
        /video\/webm/.test(req.query.ct || '') ||
        /\.ogv(\?|$)/i.test(directUrl) ||
        /\.avi(\?|$)/i.test(directUrl) ||
        /\.mkv(\?|$)/i.test(directUrl) ||
        /\.flv(\?|$)/i.test(directUrl) ||
        /\.mov(\?|$)/i.test(directUrl)
      );

      if (needsTranscode) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const cmd = ffmpeg(directUrl)
          .videoCodec('libx264')
          .addOption('-profile:v', 'baseline')
          .addOption('-level', '3.0')
          .addOption('-vf', 'scale=-2:' + VIDEO_MAX_HEIGHT)
          .videoBitrate('300k')
          .audioCodec('aac')
          .audioBitrate('64k')
          .audioChannels(1)
          .format('mp4')
          .addOption('-movflags', 'frag_keyframe+empty_moov')
          .on('error', err => { console.warn('[video] ffmpeg error:', err.message); try { res.end(); } catch {} });
        cmd.pipe(res);
        return;
      }

      // ── Passthrough with Range support ──────────────────────────────
      const upstream = await axios.get(directUrl, {
        responseType: 'stream',
        headers,
        timeout: VIDEO_TIMEOUT_MS,
        validateStatus: () => true,
        maxRedirects: 5,
        maxContentLength: Infinity
      });

      const ct = upstream.headers['content-type'] || 'video/mp4';
      res.setHeader('Content-Type', ct.includes('video') ? ct : 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (upstream.headers['content-length']) res.setHeader('Content-Length',  upstream.headers['content-length']);
      if (upstream.headers['content-range'])  res.setHeader('Content-Range',   upstream.headers['content-range']);
      res.status(upstream.status === 206 ? 206 : 200);
      upstream.data.pipe(res);
      return;
    }

    res.status(400).send('<html><body><p>No video source specified.</p><a href="/">Back</a></body></html>');

  } catch(err) {
    console.error('[video] error:', err.message);
    videoError(err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// §16  SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');
  const proxyBase = req.protocol + '://' + req.get('host');
  try {
    const data    = await fetchSearch(q);
    const results = (data.results || []).slice(0, 12);
    let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Search: ${q.replace(/</g,'&lt;')}</title>
<style>
body{font-family:Arial,sans-serif;padding:8px;background:#f5f5f5;font-size:13px;width:100%;max-width:600px;margin:0 auto;-webkit-box-sizing:border-box;box-sizing:border-box;}
h3{color:#336;font-size:13px;margin:4px 0;}
.r{margin-bottom:8px;padding:5px;background:#fff;border:1px solid #ccc;-webkit-border-radius:3px;border-radius:3px;}
.r a{color:#00c;font-size:13px;font-weight:bold;text-decoration:none;}
.r a:hover{text-decoration:underline;}
.r small{color:#080;display:block;font-size:10px;word-break:break-all;margin:2px 0;}
.r p{margin:2px 0;color:#333;font-size:11px;}
form{margin-bottom:6px;}
input[name=q]{width:70%;font-size:12px;padding:4px;border:1px solid #aaa;-webkit-border-radius:3px;border-radius:3px;}
input[type=submit]{font-size:12px;padding:4px 8px;}
@media screen and (max-width:340px){input[name=q]{width:55%;}}
</style>
</head><body>
<form method="GET" action="/search">
<input name="q" value="${q.replace(/"/g,'&quot;')}">
<input type="submit" value="Search"> | <a href="/">Home</a>
</form>
<h3>Results for &quot;${q.replace(/</g,'&lt;')}&quot;</h3>`;

    if (results.length) {
      for (const r of results) {
        const title = (r.title || r.url || '').replace(/</g,'&lt;');
        const snip  = (r.content || '').replace(/</g,'&lt;').substring(0, 200);
        html += `<div class="r"><a href="${proxyBase}/proxy?url=${encodeURIComponent(r.url)}">${title}</a>
<small>${r.url.substring(0,80)}</small>${snip ? '<p>' + snip + '</p>' : ''}</div>`;
      }
    } else {
      html += '<p>No results found.</p>';
    }
    html += '</body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch(e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send('<html><body><h3>Search failed</h3><p>' + e.message + '</p>' +
      '<a href="/proxy?url=' + encodeURIComponent('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)) +
      '">Try DDG Lite directly</a> | <a href="/">Home</a></body></html>');
  }
});

// ── GET FORM ─────────────────────────────────────────────────────────────────
app.get('/form-get', async (req, res) => {
  const targetUrl = req.query.__proxy_url;
  if (!targetUrl) return res.redirect('/');
  const params = Object.assign({}, req.query);
  delete params.__proxy_url;
  try {
    const u = new urlModule.URL(targetUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return res.redirect('/proxy?url=' + encodeURIComponent(u.href));
  } catch {
    const qs = new urlModule.URLSearchParams(params).toString();
    return res.redirect('/proxy?url=' + encodeURIComponent(targetUrl + (qs ? (targetUrl.includes('?') ? '&' : '?') + qs : '')));
  }
});

// ── POST FORM ────────────────────────────────────────────────────────────────
app.use('/form-post', express.urlencoded({ extended: true, limit: '2mb' }));
app.use('/form-post', express.json({ limit: '2mb' }));
app.all('/form-post', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');
  const proxyBase = req.protocol + '://' + req.get('host');
  try {
    const response = await proxyFetch(targetUrl, {
      method: req.method,
      data: req.body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (response.status >= 300 && response.status < 400 && response.headers.location)
      return res.redirect('/proxy?url=' + encodeURIComponent(resolveUrl(targetUrl, response.headers.location)));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(transformHTML(response.data.toString('utf-8'), targetUrl, proxyBase));
  } catch { res.send('Form submission failed'); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// §17  CATCH-ALL — resolve relative resource URLs from referring proxied page
// ═══════════════════════════════════════════════════════════════════════════════

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const referer = req.headers['referer'] || req.headers['referrer'] || '';
  const match   = referer.match(/[?&]url=([^&]+)/);
  if (match) {
    try {
      const origin = new urlModule.URL(decodeURIComponent(match[1]));
      return res.redirect('/proxy?url=' + encodeURIComponent(origin.protocol + '//' + origin.host + req.url));
    } catch {}
  }
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send('<html><body><h3>Not found</h3><p><code>' + req.url + '</code></p><a href="/">Home</a></body></html>');
});

// ═══════════════════════════════════════════════════════════════════════════════
// §18  START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  3DS NEGATIVE-PASSTHROUGH PROXY              ║');
  console.log('║  Listening on port ' + PORT.toString().padEnd(25) + '║');
  console.log('╟──────────────────────────────────────────────╢');
  console.log('║  ytdl-core:  ' + (ytdl   ? '✓ YouTube streaming' : '✗ not installed').padEnd(32) + '║');
  console.log('║  ffmpeg:     ' + (ffmpeg ? '✓ video transcode'  : '✗ not installed').padEnd(32) + '║');
  console.log('║  sharp:      ' + (sharp  ? '✓ image convert'    : '✗ not installed').padEnd(32) + '║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
  if (!ytdl)   console.log('  → Install ytdl-core:          npm install ytdl-core');
  if (!ffmpeg) console.log('  → Install ffmpeg (optional):  npm install fluent-ffmpeg ffmpeg-static');
  if (!sharp)  console.log('  → Install sharp  (optional):  npm install sharp');
  console.log('');
});
