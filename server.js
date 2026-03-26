const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const css = require('css');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveUrl(base, relative) {
  try {
    return new url.URL(relative, base).href;
  } catch {
    return relative;
  }
}

function proxyUrl(targetUrl, baseProxyUrl) {
  return `${baseProxyUrl}/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// ─── CSS Transformer: CSS3 → CSS2.1 ─────────────────────────────────────────

function transformCSS(rawCss, baseUrl, proxyBase) {
  // Fix url() references
  rawCss = rawCss.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
    if (u.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, u);
    return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
  });

  let parsed;
  try {
    parsed = css.parse(rawCss, { silent: true });
  } catch (e) {
    return '/* CSS parse error */';
  }

  const keepRules = [];

  for (const rule of parsed.stylesheet.rules || []) {
    // Drop @keyframes, @supports, @font-face (often broken on 3DS)
    if (rule.type === 'keyframes' || rule.type === 'supports') continue;

    // Keep @media but simplify
    if (rule.type === 'media') {
      // Keep only screen/all media, drop print/speech
      if (rule.media && /print|speech|braille/.test(rule.media)) continue;
      const innerKept = [];
      for (const inner of rule.rules || []) {
        if (inner.type === 'rule') {
          inner.declarations = transformDeclarations(inner.declarations || []);
          innerKept.push(inner);
        }
      }
      rule.rules = innerKept;
      if (innerKept.length > 0) keepRules.push(rule);
      continue;
    }

    if (rule.type === 'rule') {
      rule.declarations = transformDeclarations(rule.declarations || []);
      keepRules.push(rule);
      continue;
    }

    // Keep @import, @charset etc
    keepRules.push(rule);
  }

  parsed.stylesheet.rules = keepRules;

  try {
    return css.stringify(parsed);
  } catch (e) {
    return rawCss;
  }
}

// Properties to drop entirely (unsupported on 3DS NetFront)
const UNSUPPORTED_PROPS = new Set([
  'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-basis', 'align-items', 'align-content',
  'align-self', 'justify-content', 'justify-items', 'justify-self',
  'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows',
  'grid-area', 'grid-column', 'grid-row', 'grid-gap', 'gap',
  'column-gap', 'row-gap', 'place-items', 'place-content',
  'transform', 'transition', 'animation', 'animation-name',
  'animation-duration', 'animation-fill-mode', 'animation-iteration-count',
  'will-change', 'contain', 'appearance', '-webkit-appearance',
  'backface-visibility', 'perspective',
  'mask', 'mask-image', 'clip-path', 'shape-outside',
  'mix-blend-mode', 'isolation', 'filter',
  'scroll-behavior', 'overscroll-behavior', 'scroll-snap-type',
  'pointer-events', 'touch-action', 'user-select', '-webkit-user-select',
  'object-fit', 'object-position',
  'resize', 'text-overflow', // keep display of these but not critical
]);

// Values that signal a modern value (var(), calc(), clamp(), etc.)
const MODERN_VALUE = /\b(var|calc|clamp|min|max|env|fit-content|min-content|max-content)\s*\(/i;

function transformDeclarations(decls) {
  const out = [];
  for (const decl of decls) {
    if (decl.type !== 'declaration') { out.push(decl); continue; }

    const prop = (decl.property || '').toLowerCase().trim();
    const val = (decl.value || '').trim();

    // Drop unsupported properties
    if (UNSUPPORTED_PROPS.has(prop)) continue;

    // Drop vendor-prefixed modern props
    if (/^(-webkit-|-moz-|-ms-|-o-)/.test(prop) && UNSUPPORTED_PROPS.has(prop.replace(/^-[a-z]+-/, ''))) continue;

    // Drop declarations with modern values we can't polyfill
    if (MODERN_VALUE.test(val)) continue;

    // Convert display:flex/grid → display:block as fallback
    if (prop === 'display') {
      if (val === 'flex' || val === 'inline-flex') {
        out.push({ type: 'declaration', property: 'display', value: 'block' });
        continue;
      }
      if (val === 'grid' || val === 'inline-grid') {
        out.push({ type: 'declaration', property: 'display', value: 'block' });
        continue;
      }
    }

    // Convert rem → px (1rem = 16px approx)
    if (typeof val === 'string' && val.includes('rem')) {
      decl.value = val.replace(/([\d.]+)rem/g, (m, n) => `${Math.round(parseFloat(n) * 16)}px`);
    }

    // Convert vw/vh → px approximations (3DS top screen = 400px wide, 240px tall)
    if (typeof decl.value === 'string') {
      decl.value = decl.value
        .replace(/([\d.]+)vw/g, (m, n) => `${Math.round(parseFloat(n) * 4)}px`)
        .replace(/([\d.]+)vh/g, (m, n) => `${Math.round(parseFloat(n) * 2.4)}px`);
    }

    out.push(decl);
  }
  return out;
}

// ─── JS Transformer ──────────────────────────────────────────────────────────

function transformJS(src) {
  // We can't fully transpile ES6+ without Babel, but we can:
  // 1. Strip import/export statements (they'll error on NetFront)
  // 2. Replace arrow functions with function expressions (basic heuristic)
  // 3. Replace const/let with var
  // 4. Remove template literals (best-effort)
  // Note: This is heuristic-only. Complex JS will still break.

  try {
    src = src
      // Remove ES module syntax
      .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"]\s*;?/gm, '/* import removed */')
      .replace(/^\s*export\s+default\s+/gm, 'var __export_default = ')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?/gm, '/* export removed */')
      .replace(/^\s*export\s+/gm, '/* export */ ')

      // const/let → var
      .replace(/\b(const|let)\b/g, 'var')

      // Simple arrow functions: (x) => x  →  function(x) { return x; }
      // This is intentionally limited; full transpilation needs Babel
      .replace(/\(([^)]*)\)\s*=>\s*\{/g, 'function($1) {')
      .replace(/\(([^)]*)\)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1) { return $2; }')
      .replace(/(\w+)\s*=>\s*\{/g, 'function($1) {')
      .replace(/(\w+)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1) { return $2; }');

  } catch (e) {
    // If anything goes wrong, return original (broken JS is better than crashing the proxy)
  }
  return src;
}

// ─── HTML Transformer ────────────────────────────────────────────────────────

function transformHTML(html, targetUrl, proxyBase) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const parsedTarget = new url.URL(targetUrl);

  // ── Inject 3DS compatibility meta + base styles ──────────────────────────
  $('head').prepend(`
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<style>
body { margin: 4px; padding: 0; font-family: sans-serif; font-size: 14px; background: #fff; color: #000; word-wrap: break-word; }
* { box-sizing: content-box; max-width: 100%; }
img { border: 1px solid #aaa; padding: 2px; display: block; margin: 2px 0; }
a { color: #00c; }
a:visited { color: #609; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ccc; padding: 2px 4px; font-size: 12px; }
iframe { display: none; }
input, select, textarea, button { font-size: 13px; max-width: 98%; }
pre, code { white-space: pre-wrap; word-break: break-all; font-size: 11px; }
.proxy-notice { background: #fffbe6; border: 1px solid #e6c; padding: 4px 6px; font-size: 11px; margin-bottom: 6px; }
.proxy-img-placeholder { background: #eee; border: 1px solid #aaa; padding: 4px; text-align: center; font-size: 11px; cursor: pointer; margin: 2px 0; display: block; }
.proxy-media-placeholder { background: #dde; border: 1px solid #aac; padding: 4px; text-align: center; font-size: 11px; margin: 2px 0; }
</style>
`);

  // Remove existing viewport meta so ours takes priority
  $('meta[name="viewport"]').remove();

  // ── Proxy-notice bar ─────────────────────────────────────────────────────
  $('body').prepend(`<div class="proxy-notice">3DS Proxy | <a href="${proxyBase}/">Home</a> | Viewing: ${parsedTarget.hostname}</div>`);

  // ── Rewrite <link rel="stylesheet"> ─────────────────────────────────────
  $('link[rel="stylesheet"]').each(function () {
    const href = $(this).attr('href');
    if (!href) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(targetUrl)}`);
  });

  // ── Rewrite <style> blocks ───────────────────────────────────────────────
  $('style').each(function () {
    const transformed = transformCSS($(this).html() || '', targetUrl, proxyBase);
    $(this).html(transformed);
  });

  // ── Rewrite <script src> ─────────────────────────────────────────────────
  $('script').each(function () {
    const src = $(this).attr('src');
    if (src) {
      const abs = resolveUrl(targetUrl, src);
      $(this).attr('src', `${proxyBase}/js?url=${encodeURIComponent(abs)}`);
    } else {
      // Inline script — transform it
      const code = $(this).html() || '';
      $(this).html(transformJS(code));
    }

    // Remove type="module" — 3DS can't handle it
    if ($(this).attr('type') === 'module') {
      $(this).removeAttr('type');
    }
  });

  // ── Inject minimal polyfills ─────────────────────────────────────────────
  $('head').append(`<script>
/* 3DS Proxy Polyfills */
if(!Array.prototype.forEach){Array.prototype.forEach=function(fn){for(var i=0;i<this.length;i++)fn(this[i],i,this);};}
if(!Array.prototype.map){Array.prototype.map=function(fn){var r=[];for(var i=0;i<this.length;i++)r.push(fn(this[i],i,this));return r;};}
if(!Array.prototype.filter){Array.prototype.filter=function(fn){var r=[];for(var i=0;i<this.length;i++)if(fn(this[i],i,this))r.push(this[i]);return r;};}
if(!Array.prototype.indexOf){Array.prototype.indexOf=function(v){for(var i=0;i<this.length;i++)if(this[i]===v)return i;return -1;};}
if(!String.prototype.trim){String.prototype.trim=function(){return this.replace(/^\\s+|\\s+$/g,'');};}
if(!Object.keys){Object.keys=function(o){var k=[];for(var p in o)if(o.hasOwnProperty(p))k.push(p);return k;};}
if(!document.querySelector){document.querySelector=function(s){return document.getElementById(s.replace('#',''))||null;};}
if(!window.console){window.console={log:function(){},error:function(){},warn:function(){}};}
/* Stub fetch and Promise — no-ops to prevent JS errors */
if(!window.Promise){window.Promise=function(fn){this.then=function(){return this;};this.catch=function(){return this;};};}
if(!window.fetch){window.fetch=function(){var p=new window.Promise();setTimeout(function(){},0);return p;};}
</script>`);

  // ── Images → click-to-load placeholders ─────────────────────────────────
  $('img').each(function () {
    const src = $(this).attr('src');
    const alt = $(this).attr('alt') || 'image';
    if (!src) { $(this).remove(); return; }
    const abs = resolveUrl(targetUrl, src);
    const proxied = `${proxyBase}/resource?url=${encodeURIComponent(abs)}`;
    // Replace with a tap-to-show link
    $(this).replaceWith(
      `<a href="${proxied}" class="proxy-img-placeholder">[Image: ${alt} — tap to open]</a>`
    );
  });

  // ── Video / Audio → placeholder ──────────────────────────────────────────
  $('video, audio').each(function () {
    const tag = $(this)[0].name;
    const src = $(this).attr('src') || $('source', this).first().attr('src') || '';
    const abs = src ? resolveUrl(targetUrl, src) : '';
    const label = tag === 'video' ? 'Video' : 'Audio';
    if (abs) {
      $(this).replaceWith(`<div class="proxy-media-placeholder">[${label} — <a href="${proxyBase}/resource?url=${encodeURIComponent(abs)}">open directly</a>]</div>`);
    } else {
      $(this).replaceWith(`<div class="proxy-media-placeholder">[${label} — not available on 3DS]</div>`);
    }
  });

  // ── iframes → placeholder ────────────────────────────────────────────────
  $('iframe').each(function () {
    const src = $(this).attr('src');
    if (src) {
      const abs = resolveUrl(targetUrl, src);
      $(this).replaceWith(`<div class="proxy-media-placeholder">[Embedded frame — <a href="${proxyBase}/proxy?url=${encodeURIComponent(abs)}">open in proxy</a>]</div>`);
    } else {
      $(this).remove();
    }
  });

  // ── canvas, SVG inline → notice ─────────────────────────────────────────
  $('canvas').each(function () {
    $(this).replaceWith('<div class="proxy-media-placeholder">[Canvas element — not supported on 3DS]</div>');
  });

  // ── Rewrite all links to go through proxy ───────────────────────────────
  $('a[href]').each(function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`);
  });

  // ── Rewrite form actions ─────────────────────────────────────────────────
  $('form[action]').each(function () {
    const action = $(this).attr('action');
    const abs = resolveUrl(targetUrl, action);
    $(this).attr('action', `${proxyBase}/form?url=${encodeURIComponent(abs)}`);
  });

  // ── Remove noscript (we need its content) ───────────────────────────────
  $('noscript').each(function () {
    $(this).replaceWith($(this).html());
  });

  return $.html();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Home / URL entry page
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>3DS Web Proxy</title>
<style>
body{font-family:sans-serif;margin:8px;background:#f0f0e8;font-size:14px;}
h1{font-size:18px;margin:4px 0;}
input[type=text]{width:90%;font-size:13px;padding:3px;}
input[type=submit]{font-size:13px;padding:3px 8px;}
.note{font-size:11px;color:#666;margin-top:4px;}
</style>
</head>
<body>
<h1>3DS Web Proxy</h1>
<p>Enter a URL to browse:</p>
<form method="GET" action="/proxy">
  <input type="text" name="url" value="https://" style="width:85%"><br><br>
  <input type="submit" value="Go">
</form>
<p class="note">Images and videos are hidden by default. Links open through the proxy.</p>
<p class="note">Modern JS may not fully work — static content works best.</p>
</body>
</html>`);
});

// Main proxy route
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  let parsedUrl;
  try {
    parsedUrl = new url.URL(targetUrl);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 6.0; 3DS-Proxy/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      const transformed = transformHTML(html, targetUrl, proxyBase);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(transformed);
    } else {
      // Non-HTML — pass through
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.send(response.data);
    }
  } catch (err) {
    const proxyBase2 = `${req.protocol}://${req.get('host')}`;
    res.status(502).send(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">
<html><head><title>Proxy Error</title></head><body>
<p><b>Proxy Error</b></p>
<p>Could not load: ${targetUrl}</p>
<p>Reason: ${err.message}</p>
<p><a href="${proxyBase2}/">Back to home</a></p>
</body></html>`);
  }
});

// CSS proxy route — fetches, transforms, and returns CSS
app.get('/css', async (req, res) => {
  const cssUrl = req.query.url;
  const baseUrl = req.query.base || cssUrl;
  if (!cssUrl) return res.status(400).send('/* no url */');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.get(cssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (3DS-Proxy/1.0)' },
      responseType: 'text',
      timeout: 10000,
    });
    const transformed = transformCSS(response.data, baseUrl, proxyBase);
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.send(transformed);
  } catch (err) {
    res.setHeader('Content-Type', 'text/css');
    res.send(`/* Failed to load CSS: ${err.message} */`);
  }
});

// JS proxy route — fetches and transforms JS
app.get('/js', async (req, res) => {
  const jsUrl = req.query.url;
  if (!jsUrl) return res.status(400).send('/* no url */');

  try {
    const response = await axios.get(jsUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (3DS-Proxy/1.0)' },
      responseType: 'text',
      timeout: 10000,
    });
    const transformed = transformJS(response.data);
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(transformed);
  } catch (err) {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`/* Failed to load JS: ${err.message} */`);
  }
});

// Generic resource proxy (images, fonts, etc.)
app.get('/resource', async (req, res) => {
  const resourceUrl = req.query.url;
  if (!resourceUrl) return res.status(400).send('No URL');

  try {
    const response = await axios.get(resourceUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (3DS-Proxy/1.0)' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.send(response.data);
  } catch (err) {
    res.status(502).send('Resource load failed');
  }
});

// Form submission proxy — proxies POST forms
app.use('/form', express.urlencoded({ extended: true }));
app.all('/form', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const method = req.method.toLowerCase();

  try {
    const response = await axios({
      method,
      url: targetUrl,
      data: method === 'post' ? req.body : undefined,
      params: method === 'get' ? req.body : undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0 (3DS-Proxy/1.0)',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
    });

    const contentType = (response.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      const transformed = transformHTML(html, targetUrl, proxyBase);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(transformed);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }
  } catch (err) {
    res.status(502).send(`Form submission failed: ${err.message}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`3DS Proxy running on port ${PORT}`);
});
