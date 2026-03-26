const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const css = require('css');
const urlModule = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── USER AGENT ─────────────────────────────────────────────────
const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// ─── SEARCH INSTANCES ───────────────────────────────────────────
const INSTANCES = [
  'https://searx.be',
  'https://searx.tiekoetter.com',
  'https://search.bus-hit.me',
  'https://paulgo.io',
  'https://searx.info'
];

async function fetchSearch(q) {
  for (const instance of INSTANCES) {
    try {
      const r = await axios.get(`${instance}/search`, {
        params: { q, format: 'json' },
        headers: { 'User-Agent': MODERN_UA },
        timeout: 7000
      });
      if (r.data && r.data.results) return r.data;
    } catch {}
  }
  throw new Error('All search instances failed');
}

// ─── URL HELPERS ────────────────────────────────────────────────

function resolveUrl(base, relative) {
  try {
    if (!relative) return base;
    if (relative.startsWith('data:') || relative.startsWith('javascript:')) return relative;
    if (relative.startsWith('//')) {
      const b = new urlModule.URL(base);
      return `${b.protocol}${relative}`;
    }
    return new urlModule.URL(relative, base).href;
  } catch {
    return relative;
  }
}

// Build a proxied URL for a given absolute target URL
function proxyUrl(abs, proxyBase) {
  return `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`;
}

// ─── CSS TRANSFORM ──────────────────────────────────────────────

function transformCSS(rawCss, baseUrl, proxyBase) {
  // Rewrite url() references
  rawCss = rawCss.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('#')) return match;
    const abs = resolveUrl(baseUrl, u);
    return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
  });

  // Rewrite @import "url" and @import url()
  rawCss = rawCss.replace(/@import\s+['"]([^'"]+)['"]/g, (match, u) => {
    if (u.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, u);
    return `@import '${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}'`;
  });
  rawCss = rawCss.replace(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
    if (u.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, u);
    return `@import url('${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}')`;
  });

  try {
    return css.stringify(css.parse(rawCss, { silent: true }));
  } catch {
    return rawCss;
  }
}

// ─── JS TRANSFORM ───────────────────────────────────────────────

function transformJS(src, proxyBase) {
  if (!src) return src;
  try {
    src = src
      .replace(/\b(const|let)\b/g, 'var')
      // Rewrite location.href = / window.location = assignments to absolute URLs
      .replace(/(window\.location\.href\s*=\s*|window\.location\s*=\s*|location\.href\s*=\s*)(['"])(https?:\/\/[^'"]+)(['"])/g,
        (m, pre, q1, u, q2) => `${pre}${q1}${proxyBase}/proxy?url=${encodeURIComponent(u)}${q2}`)
      // Block unsupported browser detection
      .replace(/\b(window\.location\s*=\s*['"][^'"]*unsupported[^'"]*['"])/gi, '/* blocked */')
      .replace(/document\.write\s*\(/g, 'void (');  // document.write kills old browsers
    return src;
  } catch {
    return src;
  }
}

// ─── HTML TRANSFORM ─────────────────────────────────────────────

// Safe cheerio each() wrapper — skips elements that throw (e.g. namespaced attrs)
function safeEach($, selector, fn) {
  try {
    $(selector).each(function () {
      try { fn.call(this); } catch {}
    });
  } catch {}
}

function transformHTML(html, targetUrl, proxyBase) {
  // Strip namespaced attributes before cheerio sees them — css-select crashes on them
  html = html.replace(/<[^>]+>/g, tag =>
    tag.replace(/\s[\w-]+:[\w-]+=["'][^"']*["']/g, '')   // remove ns:attr="val"
       .replace(/\s[\w-]+:[\w-]+(?=[\s>\/])/g, '')        // remove bare ns:attr
  );

  const $ = cheerio.load(html, { decodeEntities: false, xmlMode: false });

  // Remove incompatible meta tags
  $('meta[name="viewport"]').remove();
  $('meta[http-equiv="X-UA-Compatible"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  // Remove browser-check / upgrade scripts
  $('script').each(function () {
    const content = $(this).html() || '';
    if (
      content.includes('unsupported browser') ||
      content.includes('please upgrade') ||
      content.includes('browserupgrade') ||
      content.includes('outdated browser')
    ) {
      $(this).remove();
    }
  });

  // Remove noscript blocks (they confuse old browsers)
  $('noscript').remove();

  // Inject compatibility shims at top of <head>
  $('head').prepend(`
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<script>
// 3DS Proxy Shims
try { navigator.__defineGetter__('userAgent', function(){ return '${MODERN_UA.replace(/'/g, "\\'")}'; }); } catch(e){}
window.chrome = window.chrome || {};
window.CSS = window.CSS || { supports: function(){ return false; } };
if (!window.Promise) {
  window.Promise = function(fn) {
    this.then = function(cb) { return this; };
    this.catch = function(cb) { return this; };
  };
  window.Promise.resolve = function(v) { return new window.Promise(function(){}); };
  window.Promise.reject = function(v) { return new window.Promise(function(){}); };
}
if (!window.fetch) {
  window.fetch = function(url, opts) {
    return new window.Promise(function(){});
  };
}
if (!Array.prototype.forEach) {
  Array.prototype.forEach = function(fn) { for(var i=0;i<this.length;i++) fn(this[i],i,this); };
}
if (!Object.assign) {
  Object.assign = function(t) {
    for(var i=1;i<arguments.length;i++){var s=arguments[i];for(var k in s){if(Object.prototype.hasOwnProperty.call(s,k))t[k]=s[k];}}
    return t;
  };
}
if (!window.history) window.history = { pushState: function(){}, replaceState: function(){} };
if (!window.sessionStorage) { try { window.sessionStorage = { getItem:function(){return null;}, setItem:function(){}, removeItem:function(){} }; } catch(e){} }
if (!window.localStorage) { try { window.localStorage = { getItem:function(){return null;}, setItem:function(){}, removeItem:function(){} }; } catch(e){} }
// Polyfill pushState to proxy new navigations
(function() {
  var _push = history.pushState;
  history.pushState = function(state, title, url) {
    if (url) {
      var abs = url.indexOf('http') === 0 ? url : '${proxyBase}/proxy?url=' + encodeURIComponent(new(function URL(u,b){this.href=(b||'')+u;})(url,'${targetUrl}').href);
      window.location.href = '${proxyBase}/proxy?url=' + encodeURIComponent(abs);
      return;
    }
    return _push.apply(this, arguments);
  };
})();
</script>
`);

  // ── Links ──
  safeEach($, 'a[href]', function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', proxyUrl(abs, proxyBase));
  });

  // ── Forms ──
  safeEach($, 'form', function () {
    const action = $(this).attr('action') || targetUrl;
    const method = ($(this).attr('method') || 'GET').toUpperCase();
    const abs = resolveUrl(targetUrl, action);

    if (method === 'GET') {
      $(this).attr('action', `${proxyBase}/form-get`);
      $(this).prepend(`<input type="hidden" name="__proxy_url" value="${abs}">`);
    } else {
      $(this).attr('action', `${proxyBase}/form-post?url=${encodeURIComponent(abs)}`);
    }
  });

  // ── Script src ──
  safeEach($, 'script[src]', function () {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, src);
    $(this).attr('src', `${proxyBase}/js?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(targetUrl)}`);
  });

  // ── Inline scripts ──
  safeEach($, 'script:not([src])', function () {
    const content = $(this).html() || '';
    $(this).html(transformJS(content, proxyBase));
  });

  // ── Stylesheets ──
  safeEach($, 'link[rel="stylesheet"]', function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}`);
  });

  // ── Inline styles ──
  safeEach($, '[style]', function () {
    const style = $(this).attr('style') || '';
    const rewritten = style.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
      if (u.startsWith('data:') || u.startsWith('#')) return match;
      const abs = resolveUrl(targetUrl, u);
      return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
    });
    $(this).attr('style', rewritten);
  });

  // ── Images / media src ──
  const srcAttrs = [
    ['img', 'src'], ['img', 'data-src'], ['source', 'src'], ['source', 'srcset'],
    ['video', 'src'], ['audio', 'src'], ['track', 'src']
  ];
  for (const [sel, attr] of srcAttrs) {
    safeEach($, sel, function () {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:')) return;
      if (attr === 'srcset') {
        const rewritten = val.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          const abs = resolveUrl(targetUrl, u);
          return [`${proxyBase}/resource?url=${encodeURIComponent(abs)}`, ...rest].join(' ');
        }).join(', ');
        $(this).attr(attr, rewritten);
      } else {
        const abs = resolveUrl(targetUrl, val);
        $(this).attr(attr, `${proxyBase}/resource?url=${encodeURIComponent(abs)}`);
      }
    });
  }

  // ── iframes ──
  safeEach($, 'iframe[src]', function () {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return;
    const abs = resolveUrl(targetUrl, src);
    $(this).attr('src', proxyUrl(abs, proxyBase));
  });

  // ── Strip external SVG sprite references (already scrubbed from markup above) ──

  return $.html();
}

// ─── AXIOS HELPER (follows redirects through proxy) ─────────────

async function proxyFetch(targetUrl, options = {}) {
  return await axios({
    url: targetUrl,
    method: options.method || 'GET',
    headers: {
      'User-Agent': MODERN_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      ...(options.headers || {})
    },
    data: options.data,
    params: options.params,
    responseType: 'arraybuffer',
    maxRedirects: 0,                          // We handle redirects manually
    validateStatus: s => true,               // Accept all status codes
    timeout: 15000,
    decompress: true
  });
}

// ─── HOME ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>3DS Proxy</title>
<style>
body { font-family: sans-serif; padding: 10px; background: #eee; }
h2 { color: #336; }
input[name=url] { width: 75%; padding: 4px; font-size: 14px; }
input[type=submit] { padding: 4px 10px; font-size: 14px; }
</style>
</head>
<body>
<h2>3DS Web Proxy</h2>
<form method="GET" action="/go">
<input name="q" placeholder="Enter URL or search term" style="width:75%">
<input type="submit" value="Go">
</form>
<br>
<small>Tip: type a URL (e.g. google.com) or a search term</small>
</body>
</html>`);
});

// ─── SMART GO HANDLER ───────────────────────────────────────────
// Detects if input is URL or search term

app.get('/go', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');

  // Looks like a URL?
  if (/^https?:\/\//i.test(q) || /^[\w-]+\.\w{2,}(\/|$)/.test(q)) {
    const target = /^https?:\/\//i.test(q) ? q : 'http://' + q;
    return res.redirect(`/proxy?url=${encodeURIComponent(target)}`);
  }

  // Otherwise search
  return res.redirect(`/search?q=${encodeURIComponent(q)}`);
});

// ─── MAIN PROXY ─────────────────────────────────────────────────

app.get('/proxy', async (req, res) => {
  let targetUrl = (req.query.url || '').trim();
  if (!targetUrl) return res.redirect('/');

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'http://' + targetUrl;
  }

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await proxyFetch(targetUrl);
    const status = response.status;

    // Handle redirects — follow through proxy
    if (status >= 300 && status < 400 && response.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, response.headers.location);
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      try {
        res.send(transformHTML(html, targetUrl, proxyBase));
      } catch (transformErr) {
        // Fallback: send raw HTML with a warning banner
        res.send(`<!-- 3DS Proxy: transform error: ${transformErr.message} -->\n` + html);
      }
    } else if (contentType.includes('text/css')) {
      const rawCss = response.data.toString('utf-8');
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.send(transformCSS(rawCss, targetUrl, proxyBase));
    } else if (contentType.includes('javascript')) {
      const rawJs = response.data.toString('utf-8');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.send(transformJS(rawJs, proxyBase));
    } else {
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.send(response.data);
    }

  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<html><body><h3>Proxy error</h3><p>${err.message}</p><a href="/">Back</a></body></html>`);
  }
});

// ─── SEARCH ─────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const data = await fetchSearch(q);
    const results = (data.results || []).slice(0, 10);

    let html = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<title>Search: ${q}</title>
<style>
body { font-family: sans-serif; padding: 8px; background: #f5f5f5; font-size: 13px; }
h3 { color: #336; font-size: 14px; }
.r { margin-bottom: 10px; padding: 6px; background: #fff; border: 1px solid #ccc; }
.r a { color: #00c; font-size: 13px; }
.r small { color: #080; display: block; font-size: 11px; word-break: break-all; }
.r p { margin: 3px 0 0; color: #333; font-size: 12px; }
form input { width: 75%; padding: 3px; }
</style>
</head><body>
<form method="GET" action="/search">
<input name="q" value="${q.replace(/"/g, '&quot;')}">
<input type="submit" value="Search">
</form>
<h3>Results for &quot;${q}&quot;</h3>`;

    if (results.length === 0) {
      html += `<p>No results found.</p>`;
    } else {
      results.forEach(r => {
        const title = (r.title || r.url || '').replace(/</g, '&lt;');
        const snippet = (r.content || '').replace(/</g, '&lt;').substring(0, 200);
        const proxied = `${proxyBase}/proxy?url=${encodeURIComponent(r.url)}`;
        html += `<div class="r">
<a href="${proxied}">${title}</a>
<small>${r.url}</small>
${snippet ? `<p>${snippet}</p>` : ''}
</div>`;
      });
    }

    html += `<br><a href="/">Home</a></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<html><body>
<h3>Search failed</h3>
<p>${e.message}</p>
<p>All search providers timed out. Try again or <a href="/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q))}">search via DuckDuckGo Lite</a>.</p>
<a href="/">Back</a>
</body></html>`);
  }
});

// ─── /ask → /search (Brave and others use this path) ────────────

app.get('/ask', (req, res) => {
  const q = req.query.q || req.query.query || '';
  res.redirect(`/search?q=${encodeURIComponent(q)}`);
});

// ─── GET FORM HANDLER ────────────────────────────────────────────
// Handles GET forms injected with __proxy_url hidden field.
// Removes __proxy_url from query string and proxies the rest.

app.get('/form-get', async (req, res) => {
  const targetUrl = req.query.__proxy_url;
  if (!targetUrl) return res.redirect('/');

  // Build params without our injected field
  const params = { ...req.query };
  delete params.__proxy_url;

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  // Build the full target URL with query params
  try {
    const u = new urlModule.URL(targetUrl);
    for (const [k, v] of Object.entries(params)) {
      u.searchParams.set(k, v);
    }
    return res.redirect(`/proxy?url=${encodeURIComponent(u.href)}`);
  } catch {
    const qs = new urlModule.URLSearchParams(params).toString();
    const sep = targetUrl.includes('?') ? '&' : '?';
    return res.redirect(`/proxy?url=${encodeURIComponent(targetUrl + (qs ? sep + qs : ''))}`);
  }
});

// ─── POST FORM HANDLER ───────────────────────────────────────────

app.use('/form-post', express.urlencoded({ extended: true }));
app.use('/form-post', express.json());

app.all('/form-post', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await proxyFetch(targetUrl, {
      method: req.method,
      data: req.body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, response.headers.location);
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }

    const html = response.data.toString('utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(transformHTML(html, targetUrl, proxyBase));
  } catch {
    res.send('Form submission failed');
  }
});

// ─── CSS ─────────────────────────────────────────────────────────

app.get('/css', async (req, res) => {
  const targetUrl = req.query.url;
  const baseUrl = req.query.base || targetUrl;
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!targetUrl) return res.send('');

  try {
    const r = await axios.get(targetUrl, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 10000,
      validateStatus: () => true
    });
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.send(transformCSS(r.data, baseUrl, proxyBase));
  } catch {
    res.send('/* css fetch failed */');
  }
});

// ─── JS ──────────────────────────────────────────────────────────

app.get('/js', async (req, res) => {
  const targetUrl = req.query.url;
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  if (!targetUrl) return res.send('');

  try {
    const r = await axios.get(targetUrl, {
      headers: { 'User-Agent': MODERN_UA },
      timeout: 10000,
      validateStatus: () => true
    });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(transformJS(r.data.toString(), proxyBase));
  } catch {
    res.send('/* js fetch failed */');
  }
});

// ─── RESOURCE (images, fonts, etc.) ─────────────────────────────

app.get('/resource', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.end();

  try {
    const r = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': MODERN_UA },
      timeout: 15000,
      validateStatus: () => true
    });
    const ct = r.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch {
    res.end();
  }
});

// ─── CATCH-ALL: intercept any raw path not handled above ─────────
//
// This fixes the "Cannot GET /something" errors when a page redirects
// to a path that isn't one of our proxy routes (e.g. Brave's /ask,
// /search/query, etc.). We reconstruct the absolute URL from the
// Referer header and redirect to our proxy.

app.use((req, res, next) => {
  // Only intercept GET-like requests for unknown paths
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const referer = req.headers.referer || '';
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  // Try to recover the original site from the Referer
  const match = referer.match(/[?&]url=([^&]+)/);
  if (match) {
    try {
      const originUrl = decodeURIComponent(match[1]);
      const origin = new urlModule.URL(originUrl);
      // Build the absolute target from the original site's origin + the requested path
      const targetUrl = `${origin.protocol}//${origin.host}${req.url}`;
      return res.redirect(`/proxy?url=${encodeURIComponent(targetUrl)}`);
    } catch {}
  }

  // No referer context — just show a friendly error
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<html><body>
<h3>404 - Path not found in proxy</h3>
<p>Requested: <code>${req.url}</code></p>
<p>This page was reached outside of a proxied session. <a href="/">Go Home</a></p>
</body></html>`);
});

// ─── START ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`3DS Proxy running on port ${PORT}`);
});
