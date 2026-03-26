const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const css = require('css');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// ─── SEARCH INSTANCES (fallback system) ─────────────────────────

const INSTANCES = [
  'https://searx.be',
  'https://searx.tiekoetter.com',
  'https://search.bus-hit.me'
];

async function fetchSearch(q) {
  for (const instance of INSTANCES) {
    try {
      const urlSearch = `${instance}/search?q=${encodeURIComponent(q)}&format=json`;
      const r = await axios.get(urlSearch, {
        headers: { 'User-Agent': MODERN_UA },
        timeout: 6000
      });

      if (r.data && r.data.results) return r.data;
    } catch {}
  }
  throw new Error('All search instances failed');
}

// ─── HELPERS ─────────────────────────────────────────

function resolveUrl(base, relative) {
  try {
    if (!relative) return base;

    if (relative.startsWith('//')) {
      const b = new url.URL(base);
      return `${b.protocol}${relative}`;
    }

    return new url.URL(relative, base).href;
  } catch {
    return relative;
  }
}

// ─── TRANSFORMS ─────────────────────────────────────

function transformCSS(rawCss, baseUrl, proxyBase) {
  rawCss = rawCss.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
    if (u.startsWith('data:')) return match;
    const abs = resolveUrl(baseUrl, u);
    return `url('${proxyBase}/resource?url=${encodeURIComponent(abs)}')`;
  });

  try {
    return css.stringify(css.parse(rawCss, { silent: true }));
  } catch {
    return rawCss;
  }
}

function transformJS(src) {
  try {
    return src
      .replace(/\b(const|let)\b/g, 'var')
      .replace(/window\.location\s*=\s*['"][^'"]*unsupported[^'"]*['"]/gi, '// blocked');
  } catch {
    return src;
  }
}

function transformHTML(html, targetUrl, proxyBase) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('meta[name="viewport"]').remove();
  $('meta[http-equiv="X-UA-Compatible"]').remove();

  // Remove basic "unsupported browser" scripts
  $('script').each(function () {
    const content = $(this).html() || '';
    if (content.includes('unsupported browser') || content.includes('please upgrade')) {
      $(this).remove();
    }
  });

  // Inject polyfills
  $('head').prepend(`
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=400">
<script>
navigator.userAgent='${MODERN_UA}';
window.chrome={};
window.CSS={};
window.navigator.webdriver=false;
window.Promise=window.Promise||function(fn){this.then=function(){return this};this.catch=function(){return this}};
window.fetch=window.fetch||function(){return new Promise(function(){})};
</script>
`);

  // Links → proxy
  $('a[href]').each(function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`);
  });

  // Forms → proxy
  $('form[action]').each(function () {
    const abs = resolveUrl(targetUrl, $(this).attr('action'));
    $(this).attr('action', `${proxyBase}/form?url=${encodeURIComponent(abs)}`);
  });

  // Scripts
  $('script').each(function () {
    const src = $(this).attr('src');
    if (src) {
      const abs = resolveUrl(targetUrl, src);
      $(this).attr('src', `${proxyBase}/js?url=${encodeURIComponent(abs)}`);
    } else {
      $(this).html(transformJS($(this).html() || ''));
    }
  });

  // CSS
  $('link[rel="stylesheet"]').each(function () {
    const abs = resolveUrl(targetUrl, $(this).attr('href'));
    $(this).attr('href', `${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(targetUrl)}`);
  });

  return $.html();
}

// ─── HOME ───────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`
<h2>3DS Proxy</h2>
<form method="GET" action="/proxy" onsubmit="return go(this)">
<input name="url" style="width:80%">
<input type="submit" value="Go">
</form>
<script>
function go(f){
  var v=f.url.value.trim();
  if(!v) return false;
  if(v.includes('.')||v.startsWith('http')){
    return true;
  }
  location='/search?q='+encodeURIComponent(v);
  return false;
}
</script>
`);
});

// ─── MAIN PROXY ─────────────────────────────────────

app.get('/proxy', async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'http://' + targetUrl;
  }

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const response = await axios.get(targetUrl, {
      headers: { 'User-Agent': MODERN_UA },
      responseType: 'arraybuffer',
      maxRedirects: 0,
      validateStatus: s => s < 400 || (s >= 300 && s < 400),
    });

    // Redirect fix
    if (response.status >= 300 && response.headers.location) {
      const redirectUrl = resolveUrl(targetUrl, response.headers.location);
      return res.redirect(`/proxy?url=${encodeURIComponent(redirectUrl)}`);
    }

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf-8');
      res.send(transformHTML(html, targetUrl, proxyBase));
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }

  } catch (err) {
    res.send('Proxy error: ' + err.message);
  }
});

// ─── SEARCH ─────────────────────────────────────────

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.send('No query');

  const proxyBase = `${req.protocol}://${req.get('host')}`;

  try {
    const data = await fetchSearch(q);
    const results = (data.results || []).slice(0, 10);

    let html = `<h3>Results for "${q}"</h3>`;

    results.forEach(r => {
      html += `<p>
        <a href="${proxyBase}/proxy?url=${encodeURIComponent(r.url)}">${r.title}</a><br>
        ${r.content || ''}
      </p>`;
    });

    res.send(html);

  } catch (e) {
    res.send(`
<h3>Search failed</h3>
<p>All search instances failed.</p>
<a href="/">Back</a>
`);
  }
});

// ─── ASK (fixes Brave /ask) ─────────────────────────

app.get('/ask', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.redirect('/');

  return res.redirect(`/search?q=${encodeURIComponent(q)}`);
});

// ─── CSS / JS / RESOURCE ────────────────────────────

app.get('/css', async (req, res) => {
  try {
    const r = await axios.get(req.query.url, { headers: { 'User-Agent': MODERN_UA } });
    res.send(transformCSS(r.data, req.query.base, `${req.protocol}://${req.get('host')}`));
  } catch {
    res.send('');
  }
});

app.get('/js', async (req, res) => {
  try {
    const r = await axios.get(req.query.url, { headers: { 'User-Agent': MODERN_UA } });
    res.send(transformJS(r.data));
  } catch {
    res.send('');
  }
});

app.get('/resource', async (req, res) => {
  try {
    const r = await axios.get(req.query.url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': MODERN_UA }
    });
    res.setHeader('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    res.send(r.data);
  } catch {
    res.send('');
  }
});

// ─── FORM FIX (IMPORTANT) ───────────────────────────

app.use('/form', express.urlencoded({ extended: true }));

app.all('/form', async (req, res) => {
  const targetUrl = req.query.url;
  const proxyBase = `${req.protocol}://${req.get('host')}`;

  const params = { ...req.query };
  delete params.url;

  try {
    const r = await axios({
      method: req.method,
      url: targetUrl,
      data: req.method === 'POST' ? req.body : undefined,
      params: req.method === 'GET' ? params : undefined,
      headers: { 'User-Agent': MODERN_UA },
      responseType: 'arraybuffer'
    });

    const html = r.data.toString('utf-8');
    res.send(transformHTML(html, targetUrl, proxyBase));

  } catch {
    res.send('Form failed');
  }
});

// ─── START ──────────────────────────────────────────

app.listen(PORT, () => {
  console.log('3DS Proxy running on ' + PORT);
});
