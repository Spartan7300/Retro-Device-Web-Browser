const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const css = require('css');
const urlModule = require('url');

// Optional: ytdl-core for YouTube video streaming (npm install ytdl-core)
let ytdl = null;
try { ytdl = require('ytdl-core'); } catch(e) { console.warn('[proxy] ytdl-core not installed — YouTube download disabled'); }

const app = express();
const PORT = process.env.PORT || 3000;

// ─── USER AGENT ─────────────────────────────────────────────────
const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

// ─── DDG LITE SEARCH ────────────────────────────────────────────
async function fetchSearch(q) {
  try {
    const r = await axios.get('https://lite.duckduckgo.com/lite/', {
      params: { q },
      headers: { 'User-Agent': MODERN_UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.5' },
      timeout: 10000,
      validateStatus: () => true
    });
    const $ = cheerio.load(r.data);
    const results = [];
    $('a.result-link').each(function () {
      const href = $(this).attr('href') || '';
      const title = $(this).text().trim();
      let realUrl = href;
      try {
        const u = new urlModule.URL('https://lite.duckduckgo.com' + href);
        realUrl = u.searchParams.get('uddg') || href;
      } catch { try { realUrl = new urlModule.URL(href).href; } catch {} }
      if (realUrl && title) results.push({ url: realUrl, title, content: '' });
    });
    $('td.result-snippet').each(function (i) {
      if (results[i]) results[i].content = $(this).text().trim();
    });
    if (results.length) return { results };
  } catch {}

  // SearX fallback
  for (const inst of ['https://searx.be','https://searx.tiekoetter.com','https://search.bus-hit.me','https://paulgo.io']) {
    try {
      const r = await axios.get(`${inst}/search`, {
        params: { q, format: 'json' },
        headers: { 'User-Agent': MODERN_UA },
        timeout: 7000
      });
      if (r.data && r.data.results && r.data.results.length) return r.data;
    } catch {}
  }
  throw new Error('All search providers failed');
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
  } catch { return relative; }
}

function proxyUrl(abs, proxyBase) {
  return `${proxyBase}/proxy?url=${encodeURIComponent(abs)}`;
}

// ═══════════════════════════════════════════════════════════════════
// CSS TRANSFORMATION PIPELINE — 3DS WebKit (r534) compatibility
// Strategy:
//  1. Pre-process raw CSS text (variables, imports, url proxying)
//  2. Parse AST and walk rules, downgrading each declaration
//  3. Selector modernisation (pseudo-classes, :is/:where/:has etc.)
//  4. Media query filtering (keep only width/height/print queries)
//  5. Inject a polished base stylesheet that makes pages look good
// ═══════════════════════════════════════════════════════════════════

// ── CSS variable registry ─────────────────────────────────────────
// First-pass extraction of :root / html variable definitions
// so we can substitute them with real values instead of "inherit".
function extractCSSVars(rawCss) {
  const vars = {};
  const rootBlocks = rawCss.match(/(?::root|html)\s*\{([^}]*)\}/gi) || [];
  for (const block of rootBlocks) {
    const inner = block.replace(/^[^{]+\{/, '').replace(/\}$/, '');
    const decls = inner.match(/--[\w-]+\s*:[^;]+/g) || [];
    for (const d of decls) {
      const colon = d.indexOf(':');
      const name = d.slice(0, colon).trim();
      const val  = d.slice(colon + 1).trim();
      vars[name] = val;
    }
  }
  return vars;
}

// Resolve a CSS variable reference, with circular-ref guard
function resolveVar(name, vars, depth) {
  if (depth > 8) return '';
  const val = vars[name];
  if (!val) return '';
  return val.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (m, n, fb) => {
    const resolved = resolveVar(n, vars, depth + 1);
    return resolved || (fb ? fb.trim() : '');
  });
}

// ── Value downgrader ──────────────────────────────────────────────
function downgradeCSSValue(prop, value, vars) {
  if (!value) return value;

  // CSS variables — resolve against registry first, fallback arg, then safe defaults
  value = value.replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\)/gi, (m, name, fb) => {
    const resolved = resolveVar(name, vars || {}, 0);
    if (resolved) return resolved;
    if (fb) return fb.trim();
    if (/color|background/.test(prop)) return 'transparent';
    if (/width|height|size|radius|gap|padding|margin|border/.test(prop)) return '0';
    return '';
  });

  // rgba(r g b / a) modern space-syntax → rgb(r,g,b)
  value = value.replace(/rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*[\d.%]+)?\s*\)/gi,
    (m, r, g, b) => 'rgb(' + r + ',' + g + ',' + b + ')');
  // rgba(r,g,b,a) → rgb(r,g,b)
  value = value.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,[^)]+\)/gi,
    (m, r, g, b) => 'rgb(' + r + ',' + g + ',' + b + ')');
  // hsl(h s% l%) modern syntax → hsl(h,s%,l%)
  value = value.replace(/hsla?\(\s*([\d.]+)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*[\d.%]+)?\s*\)/gi,
    (m, h, s, l) => 'hsl(' + h + ',' + s + ',' + l + ')');
  // hsla(h,s,l,a) → hsl(h,s,l)
  value = value.replace(/hsla\(([^,]+,[^,]+,[^,]+),[^)]+\)/gi,
    (m, inner) => 'hsl(' + inner + ')');

  // calc() — evaluate where possible, safe fallback otherwise
  value = value.replace(/calc\(([^)]+)\)/gi, function(m, expr) {
    try {
      var su = expr.match(/^([\d.]+)(px|em|rem|%)\s*([+\-])\s*([\d.]+)\2$/);
      if (su) {
        var v = su[3] === '+' ? +su[1] + +su[4] : +su[1] - +su[4];
        return Math.max(0, v) + su[2];
      }
      var pn = expr.match(/^([\d.]+)\s*([+\-\*\/])\s*([\d.]+)$/);
      if (pn) {
        var a = +pn[1], op = pn[2], b = +pn[3];
        return String(op==='+'?a+b : op==='-'?a-b : op==='*'?a*b : b ? +(a/b).toFixed(4) : a);
      }
      if (/^100%\s*-\s*[\d.]+px$/.test(expr)) return '95%';
      if (/width|height|size/.test(prop)) return '100%';
    } catch(e) {}
    return 'auto';
  });

  // clamp(min, val, max) → val
  value = value.replace(/clamp\(\s*[^,]+,\s*([^,]+),\s*[^)]+\)/gi, function(m, v) { return v.trim(); });
  // min(a,b) → a  /  max(a,b) → b
  value = value.replace(/\bmin\(\s*([^,)]+),[^)]+\)/gi, function(m, a) { return a.trim(); });
  value = value.replace(/\bmax\([^,]+,\s*([^)]+)\)/gi, function(m, b) { return b.trim(); });

  // Gradients → extract first usable colour stop
  // We can't use [^)]* because stops may contain rgb()/hsl() with parens.
  // Instead strip the outer function name+paren and grab colour tokens.
  value = value.replace(/(?:linear|radial|conic)-gradient\s*\(/gi, function(m) {
    return '__GRAD__(';
  });
  value = value.replace(/__GRAD__\(([^]*?)\)/g, function(m, inner) {
    var stops = [];
    var colRe = /(#[\da-fA-F]{3,8}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|hsl\(\s*[\d.]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+\s*\)|[a-zA-Z]{3,20})/g;
    var cm2;
    var skip = /^(to|from|at|circle|ellipse|closest|farthest|cover|contain|top|bottom|left|right|center|transparent|none|deg|grad|rad|turn|px|em|rem|vh|vw)$/i;
    while ((cm2 = colRe.exec(inner)) !== null) {
      if (!skip.test(cm2[1]) && !/^\d/.test(cm2[1])) stops.push(cm2[1]);
    }
    return stops.length ? stops[0] : '#cccccc';
  });

  // env() → fallback or safe zero
  value = value.replace(/env\(\s*[\w-]+(?:\s*,\s*([^)]+))?\)/gi, function(m, fb) { return fb ? fb.trim() : '0'; });
  // fit-content / min-content / max-content → auto
  value = value.replace(/fit-content\([^)]*\)/gi, 'auto');
  value = value.replace(/\b(?:min|max)-content\b/gi, 'auto');
  // color() lch() oklch() lab() → safe fallback
  value = value.replace(/\b(?:ok)?(?:lch|lab|color)\([^)]+\)/gi, '#888888');
  // light-dark() → first argument
  value = value.replace(/light-dark\(\s*([^,)]+),[^)]+\)/gi, function(m, a) { return a.trim(); });

  return value;
}

// ── Property downgrader ───────────────────────────────────────────
function downgradeCSSProperty(decl, vars) {
  var prop = (decl.property || '').toLowerCase().trim();
  var rawVal = decl.value || '';
  var val = downgradeCSSValue(prop, rawVal, vars);

  // ── display ───────────────────────────────────────────────────
  if (prop === 'display') {
    if (/\bgrid\b|\binline-grid\b/.test(val))
      return [{ type:'declaration', property:'display', value:'block' }];
    if (val === 'flex' || val === 'inline-flex') {
      return [
        { type:'declaration', property:'display', value:'-webkit-box' },
        { type:'declaration', property:'display', value:'-webkit-flex' },
        { type:'declaration', property:'display', value:val }
      ];
    }
    if (val === 'contents')  return [];
    if (val === 'flow-root' || val === 'run-in')
      return [{ type:'declaration', property:'display', value:'block' }];
    decl.value = val; return [decl];
  }

  // ── flex properties ───────────────────────────────────────────
  if (prop === 'flex-direction') {
    var isCol = val.indexOf('column') !== -1, isRev = val.indexOf('reverse') !== -1;
    return [
      { type:'declaration', property:'-webkit-box-orient',     value: isCol ? 'vertical' : 'horizontal' },
      { type:'declaration', property:'-webkit-box-direction',  value: isRev ? 'reverse' : 'normal' },
      { type:'declaration', property:'-webkit-flex-direction', value: val },
      { type:'declaration', property:'flex-direction',         value: val }
    ];
  }
  if (prop === 'flex-wrap') {
    return [
      { type:'declaration', property:'-webkit-flex-wrap', value: val },
      { type:'declaration', property:'flex-wrap',         value: val }
    ];
  }
  if (prop === 'align-items') {
    var wkAI = { center:'center', 'flex-start':'start', 'flex-end':'end', stretch:'stretch', baseline:'baseline' };
    return [
      { type:'declaration', property:'-webkit-box-align',   value: wkAI[val] || val },
      { type:'declaration', property:'-webkit-align-items', value: val },
      { type:'declaration', property:'align-items',          value: val }
    ];
  }
  if (prop === 'align-content') {
    return [
      { type:'declaration', property:'-webkit-align-content', value: val },
      { type:'declaration', property:'align-content',          value: val }
    ];
  }
  if (prop === 'align-self') {
    return [
      { type:'declaration', property:'-webkit-align-self', value: val },
      { type:'declaration', property:'align-self',          value: val }
    ];
  }
  if (prop === 'justify-content') {
    var wkJC = { center:'center', 'flex-start':'start', 'flex-end':'end',
      'space-between':'justify', 'space-around':'justify', 'space-evenly':'justify' };
    return [
      { type:'declaration', property:'-webkit-box-pack',        value: wkJC[val] || val },
      { type:'declaration', property:'-webkit-justify-content', value: val },
      { type:'declaration', property:'justify-content',          value: val }
    ];
  }
  if (prop === 'flex' || prop === 'flex-grow') {
    var fn = parseFloat(val) || 1;
    return [
      { type:'declaration', property:'-webkit-box-flex', value: String(fn) },
      { type:'declaration', property:'-webkit-flex',     value: val },
      { type:'declaration', property:prop,               value: val }
    ];
  }
  if (prop === 'flex-shrink') {
    return [
      { type:'declaration', property:'-webkit-flex-shrink', value: val },
      { type:'declaration', property:'flex-shrink',          value: val }
    ];
  }
  if (prop === 'flex-basis') {
    return [
      { type:'declaration', property:'-webkit-flex-basis', value: val },
      { type:'declaration', property:'flex-basis',          value: val }
    ];
  }
  if (prop === 'flex-flow') {
    return [
      { type:'declaration', property:'-webkit-flex-flow', value: val },
      { type:'declaration', property:'flex-flow',          value: val }
    ];
  }
  if (prop === 'order') {
    return [
      { type:'declaration', property:'-webkit-box-ordinal-group', value: String((parseInt(val) || 0) + 1) },
      { type:'declaration', property:'-webkit-order', value: val },
      { type:'declaration', property:'order',          value: val }
    ];
  }

  // ── gap → margin approximation ────────────────────────────────
  if (prop === 'gap' || prop === 'grid-gap') {
    var gparts = val.trim().split(/\s+/);
    var gv = gparts[0];
    return [{ type:'declaration', property:'margin-bottom', value: gv }];
  }
  if (prop === 'column-gap' || prop === 'grid-column-gap') {
    return [{ type:'declaration', property:'margin-right', value: val }];
  }
  if (prop === 'row-gap' || prop === 'grid-row-gap') {
    return [{ type:'declaration', property:'margin-bottom', value: val }];
  }

  // ── grid — attempt useful conversions, drop remainder ─────────
  if (prop === 'grid-template-columns') {
    return [
      { type:'declaration', property:'display', value:'block' },
      { type:'declaration', property:'width',   value:'100%' }
    ];
  }
  if (prop.startsWith('grid-template') || prop.startsWith('grid-auto') ||
      prop === 'grid-area' || prop === 'grid-column' || prop === 'grid-row' ||
      prop === 'grid' || prop === 'grid-column-start' || prop === 'grid-column-end' ||
      prop === 'grid-row-start' || prop === 'grid-row-end') {
    return [];
  }

  // ── position:sticky ───────────────────────────────────────────
  if (prop === 'position' && val === 'sticky') {
    return [
      { type:'declaration', property:'position', value:'-webkit-sticky' },
      { type:'declaration', property:'position', value:'sticky' }
    ];
  }
  // overflow:overlay → auto
  if (prop === 'overflow' && val === 'overlay') {
    return [{ type:'declaration', property:'overflow', value:'auto' }];
  }
  if ((prop === 'overflow-x' || prop === 'overflow-y') && val === 'clip') {
    return [{ type:'declaration', property:prop, value:'hidden' }];
  }

  // ── text-decoration shorthand ─────────────────────────────────
  if (prop === 'text-decoration') {
    var tokens = val.split(/\s+/);
    var kw = null;
    for (var ti = 0; ti < tokens.length; ti++) {
      if (['underline','overline','line-through','none'].indexOf(tokens[ti]) !== -1) { kw = tokens[ti]; break; }
    }
    if (kw) return [{ type:'declaration', property:'text-decoration', value: kw }];
  }

  // ── background — strip unsupported multi-layer syntax ─────────
  if (prop === 'background' || prop === 'background-image') {
    if (val.indexOf(',') !== -1 && !val.startsWith('url(') && !/^(#|rgb|hsl)/.test(val)) {
      val = val.split(',')[0].trim();
    }
    decl.value = val; return [decl];
  }

  // ── font properties ───────────────────────────────────────────
  if (prop === 'font-feature-settings' || prop === 'font-variation-settings' ||
      prop === 'font-optical-sizing' || prop === 'font-kerning' ||
      prop === 'font-display') return [];

  // ── webkit-prefixed pairs ─────────────────────────────────────
  var wkPairs = [
    'border-radius','border-top-left-radius','border-top-right-radius',
    'border-bottom-left-radius','border-bottom-right-radius',
    'box-shadow',
    'transform','transform-origin','transform-style',
    'perspective','perspective-origin',
    'transition','transition-property','transition-duration',
    'transition-timing-function','transition-delay',
    'animation','animation-name','animation-duration','animation-timing-function',
    'animation-iteration-count','animation-fill-mode','animation-direction',
    'animation-play-state','animation-delay',
    'appearance','user-select','backface-visibility','filter',
    'columns','column-count','column-rule','column-span','column-width',
    'text-size-adjust','tap-highlight-color','overflow-scrolling','font-smoothing'
  ];
  if (wkPairs.indexOf(prop) !== -1) {
    var out = [{ type:'declaration', property:'-webkit-' + prop, value: val }];
    if (['appearance','user-select','columns','column-count','column-rule'].indexOf(prop) !== -1) {
      out.push({ type:'declaration', property:'-moz-' + prop, value: val });
    }
    out.push({ type:'declaration', property:prop, value:val });
    return out;
  }

  // ── Properties to drop entirely ───────────────────────────────
  var dropSet = new Set([
    'backdrop-filter',
    'contain','will-change','isolation','mix-blend-mode','forced-color-adjust',
    'overscroll-behavior','overscroll-behavior-x','overscroll-behavior-y',
    'scroll-snap-type','scroll-snap-align','scroll-padding','scroll-margin',
    'scroll-behavior',
    'object-fit','object-position',
    'font-variant-ligatures','font-variant-numeric','font-variant-caps',
    'font-variant-east-asian','font-variant-alternates',
    'text-decoration-color','text-decoration-style','text-decoration-thickness',
    'text-underline-offset','text-overflow-mode',
    'paint-order','shape-outside','shape-margin','shape-image-threshold',
    'counter-set','content-visibility','aspect-ratio',
    'caret-color','accent-color',
    'offset-path','offset-distance','offset-rotate',
    'mask','mask-image','mask-size','mask-position','mask-repeat','mask-clip','mask-composite',
    'clip-path',
    'writing-mode','text-orientation','text-combine-upright',
    'ruby-position','ruby-align',
    'hyphenate-character','overflow-anchor','touch-action'
  ]);
  if (dropSet.has(prop)) return [];

  decl.value = val;
  return [decl];
}

// ── Selector moderniser ───────────────────────────────────────────
function downgradeSelector(s) {
  s = s.replace(/:root\b/g, 'html');
  s = s.replace(/:is\(([^)]+)\)/g, function(m, a) { return a.split(',')[0].trim(); });
  s = s.replace(/:where\(([^)]+)\)/g, function(m, a) { return a.split(',')[0].trim(); });
  if (s.indexOf(':has(') !== -1) return null;
  s = s.replace(/:not\(([^)]+)\)/g, function(m, inner) {
    return /^[a-zA-Z0-9.#*[\]="'_-]+$/.test(inner.trim()) ? ':not(' + inner.trim() + ')' : '';
  });
  s = s.replace(/:focus-visible\b/g, ':focus');
  s = s.replace(/:focus-within\b/g, ':focus');
  s = s.replace(/:any-link\b/g, ':link');
  s = s.replace(/:placeholder-shown\b/g, ':focus');
  s = s.replace(/:user-valid\b/g, ':valid');
  s = s.replace(/:user-invalid\b/g, ':invalid');
  s = s.replace(/::before\b/g, ':before');
  s = s.replace(/::after\b/g, ':after');
  s = s.replace(/::first-line\b/g, ':first-line');
  s = s.replace(/::first-letter\b/g, ':first-letter');
  s = s.replace(/::selection\b/g, '::-webkit-selection');
  s = s.replace(/::placeholder\b/g, '::-webkit-input-placeholder');
  s = s.replace(/::marker\b/g, ':before');
  s = s.replace(/::backdrop\b/g, '');
  s = s.replace(/^&\s*/, '');
  return s.trim() || null;
}

// ── Rule processor ─────────────────────────────────────────────────
function processRules(rules, vars) {
  if (!rules) return [];
  var out = [];
  for (var ri = 0; ri < rules.length; ri++) {
    var rule = rules[ri];
    if (!rule) continue;

    if (rule.type === 'rule') {
      var selectors = (rule.selectors || []).map(downgradeSelector).filter(Boolean);
      if (!selectors.length) continue;
      rule.selectors = selectors;

      var newDecls = [];
      for (var di = 0; di < (rule.declarations || []).length; di++) {
        var d = rule.declarations[di];
        if (!d || d.type !== 'declaration') { newDecls.push(d); continue; }
        var nds = downgradeCSSProperty(d, vars);
        for (var ni = 0; ni < nds.length; ni++) newDecls.push(nds[ni]);
      }
      rule.declarations = newDecls;
      if (!newDecls.length) continue;
      out.push(rule);

    } else if (rule.type === 'keyframes') {
      if (rule.keyframes) {
        for (var ki = 0; ki < rule.keyframes.length; ki++) {
          var kf = rule.keyframes[ki];
          var nd = [];
          for (var kdi = 0; kdi < (kf.declarations || []).length; kdi++) {
            var kd = kf.declarations[kdi];
            if (!kd || kd.type !== 'declaration') { nd.push(kd); continue; }
            var knds = downgradeCSSProperty(kd, vars);
            for (var kni = 0; kni < knds.length; kni++) nd.push(knds[kni]);
          }
          kf.declarations = nd;
        }
      }
      out.push({ type:'keyframes', name: rule.name, vendor: '-webkit-', keyframes: rule.keyframes });
      out.push(rule);

    } else if (rule.type === 'media') {
      var mq = (rule.media || '').toLowerCase();
      if (/prefers-color-scheme|prefers-reduced-motion|prefers-contrast|forced-colors|display-mode|hover|pointer/.test(mq)) continue;
      rule.media = rule.media.replace(/([\d.]+)rem/g, function(m, n) { return Math.round(parseFloat(n) * 16) + 'px'; });
      var innerRules = processRules(rule.rules, vars);
      if (!innerRules.length) continue;
      rule.rules = innerRules;
      out.push(rule);

    } else if (rule.type === 'supports') {
      var suppRules = processRules(rule.rules, vars);
      for (var si = 0; si < suppRules.length; si++) out.push(suppRules[si]);

    } else if (rule.type === 'font-face') {
      var fnd = [];
      for (var fdi = 0; fdi < (rule.declarations || []).length; fdi++) {
        var fd = rule.declarations[fdi];
        if (!fd || fd.type !== 'declaration') { fnd.push(fd); continue; }
        if (['font-display','font-variation-settings','font-feature-settings',
             'font-named-instance','unicode-range'].indexOf(fd.property) !== -1) continue;
        fnd.push(fd);
      }
      rule.declarations = fnd;
      out.push(rule);

    } else if (rule.type === 'charset') {
      out.push(rule);

    } else if (rule.type === 'layer' || rule.type === 'scope') {
      if (rule.rules) {
        var lr = processRules(rule.rules, vars);
        for (var li = 0; li < lr.length; li++) out.push(lr[li]);
      }
    } else {
      out.push(rule);
    }
  }
  return out;
}

// ── Main CSS transform ─────────────────────────────────────────────
function transformCSS(rawCss, baseUrl, proxyBase) {
  if (!rawCss) return '';

  // Extract CSS variables for substitution
  var vars = extractCSSVars(rawCss);

  // Proxy @import
  rawCss = rawCss.replace(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/g, function(m, u) {
    if (u.startsWith('data:')) return m;
    var abs = resolveUrl(baseUrl, u);
    return "@import url('" + proxyBase + "/css?url=" + encodeURIComponent(abs) + "&base=" + encodeURIComponent(abs) + "')";
  });
  rawCss = rawCss.replace(/@import\s+['"]([^'"]+)['"]/g, function(m, u) {
    if (u.startsWith('data:')) return m;
    var abs = resolveUrl(baseUrl, u);
    return "@import '" + proxyBase + "/css?url=" + encodeURIComponent(abs) + "&base=" + encodeURIComponent(abs) + "'";
  });

  // Proxy url() image/font references
  rawCss = rawCss.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, function(match, u) {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('about:')) return match;
    var abs = resolveUrl(baseUrl, u);
    if (!abs || abs.startsWith('data:')) return match;
    return "url('" + proxyBase + "/resource?url=" + encodeURIComponent(abs) + "')";
  });

  // Strip bare @layer declarations
  rawCss = rawCss.replace(/@layer\s+[\w.,\s]+;/g, '');

  try {
    var ast = css.parse(rawCss, { silent: true });
    if (ast && ast.stylesheet) {
      ast.stylesheet.rules = processRules(ast.stylesheet.rules, vars);
    }
    return css.stringify(ast, { compress: false });
  } catch (e) {
    return rawCss;
  }
}


// ─── JS TRANSFORM ───────────────────────────────────────────────
function transformJS(src, proxyBase) {
  if (!src) return src;
  try {
    src = src
      // const/let → var
      .replace(/\b(const|let)\b/g, 'var')
      // Arrow functions: (...) => { → function(...){
      .replace(/\(([^)]*)\)\s*=>\s*\{/g, 'function($1){')
      // Arrow with expression body: (...) => expr
      .replace(/\(([^)]*)\)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')
      // Single-arg arrow: x => {
      .replace(/(\b\w+)\s*=>\s*\{/g, 'function($1){')
      // Single-arg arrow expression: x => expr
      .replace(/(\b\w+)\s*=>\s*([^{;\n][^\n;]*)/g, 'function($1){ return $2; }')
      // Template literals with one interpolation
      .replace(/`([^`]*?)\$\{([^}]+)\}([^`]*?)`/g,
        (m, pre, expr, post) => `"${pre.replace(/"/g,'\\"')}"+(${expr})+"${post.replace(/"/g,'\\"')}"`)
      // Template literals (plain, no interpolation)
      .replace(/`([^`]*)`/g, (m, s) => `"${s.replace(/"/g,'\\"').replace(/\n/g,'\\n')}"`)
      // Async/await
      .replace(/\basync\s+function\b/g, 'function')
      .replace(/\basync\s+\(/g, '(')
      .replace(/\bawait\s+/g, '/* await */ ')
      // for...of (array only)
      .replace(/for\s*\(\s*var\s+(\w+)\s+of\s+(\w+)\s*\)/g,
        (m, v, arr) => `for(var __fi=0,${v};__fi<${arr}.length;${v}=${arr}[__fi],__fi++)`)
      // Spread in arrays: [...x] → x (approximate)
      .replace(/\[\.\.\.(\w+)\]/g, '$1')
      // Rest/spread in args: fn(...args) → fn(args) (approximate)
      .replace(/,\s*\.\.\.(\w+)/g, ', $1')
      // Object destructuring: var {a,b} = obj
      .replace(/var\s*\{\s*([\w\s,]+)\s*\}\s*=\s*(\w+)/g, (m, keys, obj) =>
        keys.split(',').map(k => `var ${k.trim()}=${obj}.${k.trim()}`).join(';'))
      // Array destructuring: var [a,b] = arr
      .replace(/var\s*\[\s*([\w\s,]+)\s*\]\s*=\s*(\w+)/g, (m, keys, arr) =>
        keys.split(',').map((k,i) => `var ${k.trim()}=${arr}[${i}]`).join(';'))
      // Default params: function(x=1) → strip defaults
      .replace(/function\s*(\w*)\s*\(([^)]*)\)/g, (m, name, args) =>
        `function ${name}(${args.replace(/=\s*[^,)]+/g,'')})`)
      // Proxy location navigations
      .replace(/((?:window\.)?location\.href\s*=\s*)(['"])(https?:\/\/[^'"]+)(['"])/g,
        (m, pre, q1, u, q2) => `${pre}${q1}${proxyBase}/proxy?url=${encodeURIComponent(u)}${q2}`)
      // Block unsupported-browser walls
      .replace(/window\.location\s*=\s*['"][^'"]*unsupported[^'"]*['"]/gi, '/* blocked */')
      // document.write → no-op
      .replace(/document\.write\s*\(/g, 'void (');
    return src;
  } catch { return src; }
}

// ─── SHIM BLOCK ─────────────────────────────────────────────────
function buildShims(proxyBase, targetUrl) {
  const ua = MODERN_UA.replace(/'/g, "\\'");
  return `<script>
/* ===== 3DS PROXY SHIMS ===== */
/* UA */
try{Object.defineProperty(navigator,'userAgent',{get:function(){return '${ua}';}});}catch(e){}
try{Object.defineProperty(navigator,'vendor',{get:function(){return 'Google Inc.';}});}catch(e){}
try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';}});}catch(e){}
try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 1;}});}catch(e){}
/* Globals */
window.chrome=window.chrome||{runtime:{}};
window.CSS=window.CSS||{supports:function(){return false;},escape:function(s){return s;}};
window.console=window.console||{log:function(){},warn:function(){},error:function(){},info:function(){},debug:function(){}};
/* CustomEvent */
if(typeof CustomEvent==='undefined'||typeof CustomEvent!=='function'){window.CustomEvent=function(t,p){p=p||{};var e=document.createEvent('Event');e.initEvent(t,!!p.bubbles,!!p.cancelable);e.detail=p.detail||null;return e;};}
/* Storage */
if(!window.sessionStorage){try{window.sessionStorage={_d:{},getItem:function(k){return this._d.hasOwnProperty(k)?this._d[k]:null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};},key:function(i){return Object.keys(this._d)[i]||null;},length:0};}catch(e){}}
if(!window.localStorage){try{window.localStorage={_d:{},getItem:function(k){return this._d.hasOwnProperty(k)?this._d[k]:null;},setItem:function(k,v){this._d[k]=String(v);},removeItem:function(k){delete this._d[k];},clear:function(){this._d={};},key:function(i){return Object.keys(this._d)[i]||null;},length:0};}catch(e){}}
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
}
/* fetch */
if(!window.fetch){window.fetch=function(url,opts){return new window.Promise(function(res,rej){var xhr=new XMLHttpRequest();opts=opts||{};xhr.open(opts.method||'GET',url,true);if(opts.headers){for(var k in opts.headers)try{xhr.setRequestHeader(k,opts.headers[k]);}catch(e){}}xhr.onload=function(){var b=xhr.responseText;res({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,statusText:xhr.statusText,text:function(){return window.Promise.resolve(b);},json:function(){return window.Promise.resolve(JSON.parse(b));},headers:{get:function(h){return xhr.getResponseHeader(h);}}});};xhr.onerror=function(){rej(new Error('fetch failed'));};try{xhr.send(opts.body||null);}catch(e){rej(e);}});};}
/* Array */
if(!Array.prototype.forEach){Array.prototype.forEach=function(fn,ctx){for(var i=0;i<this.length;i++)if(i in this)fn.call(ctx,this[i],i,this);};}
if(!Array.prototype.map){Array.prototype.map=function(fn,ctx){var r=[];for(var i=0;i<this.length;i++)r.push(fn.call(ctx,this[i],i,this));return r;};}
if(!Array.prototype.filter){Array.prototype.filter=function(fn,ctx){var r=[];for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))r.push(this[i]);return r;};}
if(!Array.prototype.reduce){Array.prototype.reduce=function(fn,init){var i=0,acc;if(arguments.length>1){acc=init;}else{if(!this.length)throw new TypeError('reduce of empty array');acc=this[0];i=1;}for(;i<this.length;i++)acc=fn(acc,this[i],i,this);return acc;};}
if(!Array.prototype.reduceRight){Array.prototype.reduceRight=function(fn,init){var i=this.length-1,acc;if(arguments.length>1){acc=init;}else{acc=this[i];i--;}for(;i>=0;i--)acc=fn(acc,this[i],i,this);return acc;};}
if(!Array.prototype.indexOf){Array.prototype.indexOf=function(v,s){for(var i=s||0;i<this.length;i++)if(this[i]===v)return i;return -1;};}
if(!Array.prototype.lastIndexOf){Array.prototype.lastIndexOf=function(v,s){for(var i=s||this.length-1;i>=0;i--)if(this[i]===v)return i;return -1;};}
if(!Array.prototype.some){Array.prototype.some=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return true;return false;};}
if(!Array.prototype.every){Array.prototype.every=function(fn,ctx){for(var i=0;i<this.length;i++)if(!fn.call(ctx,this[i],i,this))return false;return true;};}
if(!Array.prototype.find){Array.prototype.find=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return this[i];};}
if(!Array.prototype.findIndex){Array.prototype.findIndex=function(fn,ctx){for(var i=0;i<this.length;i++)if(fn.call(ctx,this[i],i,this))return i;return -1;};}
if(!Array.prototype.includes){Array.prototype.includes=function(v,s){return this.indexOf(v,s)!==-1;};}
if(!Array.prototype.flat){Array.prototype.flat=function(d){if(d===undefined)d=1;var r=[];for(var i=0;i<this.length;i++){if(Array.isArray(this[i])&&d>0)r=r.concat(this[i].flat(d-1));else r.push(this[i]);}return r;};}
if(!Array.prototype.flatMap){Array.prototype.flatMap=function(fn,ctx){return this.map(fn,ctx).flat(1);};}
if(!Array.prototype.fill){Array.prototype.fill=function(v,s,e){s=s||0;e=e===undefined?this.length:e;for(var i=s;i<e;i++)this[i]=v;return this;};}
if(!Array.prototype.copyWithin){Array.prototype.copyWithin=function(t,s,e){var l=this.length;s=s||0;e=e===undefined?l:e;while(s<e){this[t]=this[s];t++;s++;}return this;};}
if(!Array.prototype.keys){Array.prototype.keys=function(){var i=0,t=this;return{next:function(){return i<t.length?{value:i++,done:false}:{done:true};}};};}
if(!Array.prototype.values){Array.prototype.values=function(){var i=0,t=this;return{next:function(){return i<t.length?{value:t[i++],done:false}:{done:true};}};};}
if(!Array.prototype.entries){Array.prototype.entries=function(){var i=0,t=this;return{next:function(){return i<t.length?{value:[i,t[i++]],done:false}:{done:true};}};};}
if(!Array.from){Array.from=function(a,fn){var r=[];for(var i=0;i<(a.length||0);i++)r.push(fn?fn(a[i],i):a[i]);return r;};}
if(!Array.of){Array.of=function(){return Array.prototype.slice.call(arguments);};}
if(!Array.isArray){Array.isArray=function(a){return Object.prototype.toString.call(a)==='[object Array]';};}
/* Object */
if(!Object.assign){Object.assign=function(t){for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s)for(var k in s)if(Object.prototype.hasOwnProperty.call(s,k))t[k]=s[k];}return t;};}
if(!Object.keys){Object.keys=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(k);return r;};}
if(!Object.values){Object.values=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push(o[k]);return r;};}
if(!Object.entries){Object.entries=function(o){var r=[];for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k))r.push([k,o[k]]);return r;};}
if(!Object.create){Object.create=function(p,d){function F(){}F.prototype=p;var o=new F();if(d)for(var k in d)o[k]=d[k].value;return o;};}
if(!Object.freeze){Object.freeze=function(o){return o;};}
if(!Object.isFrozen){Object.isFrozen=function(){return false;};}
if(!Object.getPrototypeOf){Object.getPrototypeOf=function(o){return o.__proto__||null;};}
if(!Object.getOwnPropertyNames){Object.getOwnPropertyNames=Object.keys;}
if(!Object.is){Object.is=function(a,b){if(a===b)return a!==0||1/a===1/b;return a!==a&&b!==b;};}
if(!Object.fromEntries){Object.fromEntries=function(entries){var o={};var arr=Array.from(entries);for(var i=0;i<arr.length;i++)o[arr[i][0]]=arr[i][1];return o;};}
/* String */
if(!String.prototype.trim){String.prototype.trim=function(){return this.replace(/^\s+|\s+$/g,'');};}
if(!String.prototype.trimStart){String.prototype.trimStart=function(){return this.replace(/^\s+/,'');};}
if(!String.prototype.trimEnd){String.prototype.trimEnd=function(){return this.replace(/\s+$/,'');};}
if(!String.prototype.startsWith){String.prototype.startsWith=function(s,p){return this.slice(p||0,s.length+(p||0))===s;};}
if(!String.prototype.endsWith){String.prototype.endsWith=function(s,l){var e=l===undefined?this.length:l;return this.slice(e-s.length,e)===s;};}
if(!String.prototype.includes){String.prototype.includes=function(s,p){return this.indexOf(s,p||0)!==-1;};}
if(!String.prototype.repeat){String.prototype.repeat=function(n){if(n<0||n===Infinity)throw new RangeError('repeat count invalid');var r='';for(var i=0;i<n;i++)r+=this;return r;};}
if(!String.prototype.padStart){String.prototype.padStart=function(n,p){p=String(p===undefined?' ':p);var s=String(this);if(s.length>=n)return s;var needed=n-s.length;while(p.length<needed)p+=p;return p.slice(0,needed)+s;};}
if(!String.prototype.padEnd){String.prototype.padEnd=function(n,p){p=String(p===undefined?' ':p);var s=String(this);if(s.length>=n)return s;var needed=n-s.length;while(p.length<needed)p+=p;return s+p.slice(0,needed);};}
if(!String.prototype.replaceAll){String.prototype.replaceAll=function(s,r){if(s instanceof RegExp){if(!s.global)throw new TypeError('replaceAll called with non-global RegExp');return this.replace(s,r);}return this.split(s).join(r);};}
if(!String.prototype.at){String.prototype.at=function(i){var n=Math.trunc(i)||0;if(n<0)n+=this.length;if(n<0||n>=this.length)return undefined;return this[n];};}
if(!String.prototype.matchAll){String.prototype.matchAll=function(re){var results=[];var m;var r=new RegExp(re.source,(re.flags||'')+(re.global?'':'g'));while((m=r.exec(this))!==null)results.push(m);return results[Symbol&&Symbol.iterator?Symbol.iterator:0]?results:{next:function(){return{done:true};}};}} /* rough stub */
if(!String.fromCodePoint){String.fromCodePoint=function(){var r='';for(var i=0;i<arguments.length;i++){var c=arguments[i];if(c>0xFFFF){c-=0x10000;r+=String.fromCharCode(0xD800+(c>>10),0xDC00+(c&0x3FF));}else r+=String.fromCharCode(c);}return r;};}
/* Number */
if(!Number.isInteger){Number.isInteger=function(v){return typeof v==='number'&&isFinite(v)&&Math.floor(v)===v;};}
if(!Number.isFinite){Number.isFinite=function(v){return typeof v==='number'&&isFinite(v);};}
if(!Number.isNaN){Number.isNaN=function(v){return typeof v==='number'&&v!==v;};}
if(!Number.isSafeInteger){Number.isSafeInteger=function(v){return Number.isInteger(v)&&Math.abs(v)<=9007199254740991;};}
if(!Number.parseInt){Number.parseInt=parseInt;}
if(!Number.parseFloat){Number.parseFloat=parseFloat;}
if(!Number.EPSILON){Number.EPSILON=2.220446049250313e-16;}
if(!Number.MAX_SAFE_INTEGER){Number.MAX_SAFE_INTEGER=9007199254740991;}
if(!Number.MIN_SAFE_INTEGER){Number.MIN_SAFE_INTEGER=-9007199254740991;}
/* Math */
if(!Math.sign){Math.sign=function(x){return x>0?1:x<0?-1:0;};}
if(!Math.trunc){Math.trunc=function(x){return x<0?Math.ceil(x):Math.floor(x);};}
if(!Math.log2){Math.log2=function(x){return Math.log(x)/0.6931471805599453;};}
if(!Math.log10){Math.log10=function(x){return Math.log(x)/2.302585092994046;};}
if(!Math.hypot){Math.hypot=function(){var s=0;for(var i=0;i<arguments.length;i++)s+=arguments[i]*arguments[i];return Math.sqrt(s);};}
if(!Math.cbrt){Math.cbrt=function(x){return x<0?-Math.pow(-x,1/3):Math.pow(x,1/3);};}
if(!Math.fround){Math.fround=function(x){return x;};}
if(!Math.imul){Math.imul=function(a,b){var ah=a>>>16,al=a&0xFFFF,bh=b>>>16,bl=b&0xFFFF;return(al*bl)+((ah*bl+al*bh)<<16)|0;};}
if(!Math.clz32){Math.clz32=function(x){if(!x)return 32;var n=0;if(!(x&0xFFFF0000)){n+=16;x<<=16;}if(!(x&0xFF000000)){n+=8;x<<=8;}if(!(x&0xF0000000)){n+=4;x<<=4;}if(!(x&0xC0000000)){n+=2;x<<=2;}return n+!(x&0x80000000);};}
/* JSON */
var _jp=JSON.parse;JSON.parse=function(s){try{return _jp(s);}catch(e){try{return eval('('+s+')');}catch(e2){return null;}}};
/* Date */
if(!Date.now){Date.now=function(){return new Date().getTime();};}
/* setTimeout */
var _st=window.setTimeout;window.setTimeout=function(fn,ms){return _st(fn,ms||0);};
/* rAF */
if(!window.requestAnimationFrame){window.requestAnimationFrame=function(fn){return setTimeout(fn,16);};}
if(!window.cancelAnimationFrame){window.cancelAnimationFrame=function(id){clearTimeout(id);};}
/* performance */
if(!window.performance){window.performance={now:function(){return Date.now();}};}
else if(!window.performance.now){window.performance.now=function(){return Date.now();};}
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
}
/* URLSearchParams */
if(typeof URLSearchParams==='undefined'){window.URLSearchParams=function(init){this._d={};var self=this;if(typeof init==='string')(init.replace(/^\?/,'').split('&')).forEach(function(p){if(!p)return;var kv=p.split('=');self._d[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||'');});this.get=function(k){return this._d[k]||null;};this.set=function(k,v){this._d[k]=String(v);};this.has=function(k){return this._d.hasOwnProperty(k);};this.delete=function(k){delete this._d[k];};this.toString=function(){return Object.keys(this._d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(this._d[k]);},this).join('&');};};}
/* Symbol */
if(typeof Symbol==='undefined'){var _sc=0;window.Symbol=function(d){return '__sym_'+(d||'')+(_sc++)+'__';};window.Symbol.iterator='__sym_iterator__';window.Symbol.hasInstance='__sym_hasInstance__';window.Symbol.toPrimitive='__sym_toPrimitive__';window.Symbol.toStringTag='__sym_toStringTag__';window.Symbol.for=function(k){return '__symfor_'+k+'__';};}
/* WeakMap */
if(typeof WeakMap==='undefined'){window.WeakMap=function(){this._k=[];this._v=[];};window.WeakMap.prototype={get:function(k){var i=this._k.indexOf(k);return i>-1?this._v[i]:undefined;},set:function(k,v){var i=this._k.indexOf(k);if(i>-1)this._v[i]=v;else{this._k.push(k);this._v.push(v);}return this;},has:function(k){return this._k.indexOf(k)>-1;},delete:function(k){var i=this._k.indexOf(k);if(i>-1){this._k.splice(i,1);this._v.splice(i,1);}return true;}};}
/* WeakSet */
if(typeof WeakSet==='undefined'){window.WeakSet=function(){this._i=[];};window.WeakSet.prototype={add:function(v){if(!this.has(v))this._i.push(v);return this;},has:function(v){return this._i.indexOf(v)>-1;},delete:function(v){var i=this._i.indexOf(v);if(i>-1)this._i.splice(i,1);return true;}};}
/* Map */
if(typeof Map==='undefined'){window.Map=function(init){this._k=[];this._v=[];if(init){var arr=Array.from(init);for(var i=0;i<arr.length;i++)this.set(arr[i][0],arr[i][1]);}};window.Map.prototype={get:function(k){var i=this._k.indexOf(k);return i>-1?this._v[i]:undefined;},set:function(k,v){var i=this._k.indexOf(k);if(i>-1)this._v[i]=v;else{this._k.push(k);this._v.push(v);}return this;},has:function(k){return this._k.indexOf(k)>-1;},delete:function(k){var i=this._k.indexOf(k);if(i>-1){this._k.splice(i,1);this._v.splice(i,1);}return true;},clear:function(){this._k=[];this._v=[];},forEach:function(fn,ctx){for(var i=0;i<this._k.length;i++)fn.call(ctx,this._v[i],this._k[i],this);},get size(){return this._k.length;},keys:function(){var k=this._k.slice();var i=0;return{next:function(){return i<k.length?{value:k[i++],done:false}:{done:true};}};},values:function(){var v=this._v.slice();var i=0;return{next:function(){return i<v.length?{value:v[i++],done:false}:{done:true};}};},entries:function(){var k=this._k.slice(),v=this._v.slice(),i=0;return{next:function(){return i<k.length?{value:[k[i],v[i++]],done:false}:{done:true};}};}};}
/* Set */
if(typeof Set==='undefined'){window.Set=function(init){this._i=[];if(init){var arr=Array.from(init);for(var i=0;i<arr.length;i++)this.add(arr[i]);}};window.Set.prototype={add:function(v){if(!this.has(v))this._i.push(v);return this;},has:function(v){return this._i.indexOf(v)>-1;},delete:function(v){var i=this._i.indexOf(v);if(i>-1){this._i.splice(i,1);}return true;},clear:function(){this._i=[];},forEach:function(fn,ctx){for(var i=0;i<this._i.length;i++)fn.call(ctx,this._i[i],this._i[i],this);},get size(){return this._i.length;},values:function(){var d=this._i.slice(),i=0;return{next:function(){return i<d.length?{value:d[i++],done:false}:{done:true};}};},keys:function(){return this.values();},entries:function(){var d=this._i.slice(),i=0;return{next:function(){return i<d.length?{value:[d[i],d[i++]],done:false}:{done:true};}};}};}
/* Proxy stub */
if(typeof Proxy==='undefined'){window.Proxy=function(t,h){return t;};}
/* Reflect */
if(typeof Reflect==='undefined'){window.Reflect={apply:function(fn,ctx,args){return fn.apply(ctx,args);},construct:function(T,args){function F(){return T.apply(this,args);}F.prototype=T.prototype;return new F();},ownKeys:Object.keys,has:function(t,k){return k in t;},get:function(t,k){return t[k];},set:function(t,k,v){t[k]=v;return true;},deleteProperty:function(t,k){delete t[k];return true;}};}
/* MutationObserver */
if(typeof MutationObserver==='undefined'){window.MutationObserver=function(){};window.MutationObserver.prototype={observe:function(){},disconnect:function(){},takeRecords:function(){return[];}};}
/* IntersectionObserver */
if(typeof IntersectionObserver==='undefined'){window.IntersectionObserver=function(fn,opts){this._fn=fn;};window.IntersectionObserver.prototype={observe:function(){},unobserve:function(){},disconnect:function(){},takeRecords:function(){return[];}};}
/* ResizeObserver */
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
/* Uint8Array etc. — just make sure they exist */
if(typeof Uint8Array==='undefined'){window.Uint8Array=Array;}
if(typeof Int32Array==='undefined'){window.Int32Array=Array;}
if(typeof Float64Array==='undefined'){window.Float64Array=Array;}
/* btoa/atob */
if(!window.btoa){window.btoa=function(s){var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';var r='';for(var i=0;i<s.length;i+=3){var b=s.charCodeAt(i)<<16|(s.charCodeAt(i+1)||0)<<8|(s.charCodeAt(i+2)||0);r+=chars[b>>18]+chars[(b>>12)&63]+chars[(b>>6)&63]+chars[b&63];}return r.slice(0,r.length-[0,0,2,1][s.length%4]).replace(/.{2}$/,function(m){return m+'='.repeat([0,0,2,1][s.length%4]);});};}
if(!window.atob){window.atob=function(s){var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';s=s.replace(/[^A-Za-z0-9+/=]/g,'');var r='';for(var i=0;i<s.length;i+=4){var b=chars.indexOf(s[i])<<18|chars.indexOf(s[i+1])<<12|chars.indexOf(s[i+2])<<6|chars.indexOf(s[i+3]);r+=String.fromCharCode((b>>16)&255,(b>>8)&255,b&255);}return r;};}
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
  history.pushState=function(s,t,url){intercept(url);try{if(_push)_push.apply(this,arguments);}catch(e){}};
  history.replaceState=function(s,t,url){intercept(url);try{if(_rep)_rep.apply(this,arguments);}catch(e){}};
})();
/* ===== END SHIMS ===== */
</script>`;
}

// ─── HTML TRANSFORM ─────────────────────────────────────────────
function safeEach($, selector, fn) {
  try { $(selector).each(function () { try { fn.call(this); } catch {} }); } catch {}
}

function transformHTML(html, targetUrl, proxyBase) {
  // Strip XML namespaced attributes before cheerio sees them
  html = html.replace(/<[^>]+>/g, tag =>
    tag.replace(/\s[\w-]+:[\w-]+=["'][^"']*["']/g, '')
       .replace(/\s[\w-]+:[\w-]+(?=[\s>\/])/g, '')
  );

  const $ = cheerio.load(html, { decodeEntities: false, xmlMode: false });

  $('meta[name="viewport"]').remove();
  $('meta[http-equiv="X-UA-Compatible"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Content-Type-Options"]').remove();

  $('script').each(function () {
    const c = $(this).html() || '';
    if (/unsupported browser|please upgrade|browserupgrade|outdated browser|browsehappy/i.test(c)) $(this).remove();
  });
  $('noscript').remove();

  $('head').prepend(
    `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=2.0">\n` +
    buildShims(proxyBase, targetUrl)
  );

  safeEach($, 'a[href]', function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('data:')) return;
    $(this).attr('href', proxyUrl(resolveUrl(targetUrl, href), proxyBase));
  });

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

  safeEach($, 'script[src]', function () {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:')) return;
    $(this).attr('src', `${proxyBase}/js?url=${encodeURIComponent(resolveUrl(targetUrl, src))}&base=${encodeURIComponent(targetUrl)}`);
  });

  safeEach($, 'script:not([src])', function () {
    $(this).html(transformJS($(this).html() || '', proxyBase));
  });

  safeEach($, 'link[rel="stylesheet"]', function () {
    const href = $(this).attr('href');
    if (!href || href.startsWith('data:')) return;
    const abs = resolveUrl(targetUrl, href);
    $(this).attr('href', `${proxyBase}/css?url=${encodeURIComponent(abs)}&base=${encodeURIComponent(abs)}`);
  });

  // ── Inline <style> tags — transform through the CSS pipeline ──
  // This is critical: many modern sites embed all their CSS variables
  // and critical layout rules in inline <style> blocks.
  safeEach($, 'style', function () {
    const raw = $(this).html() || '';
    if (!raw.trim()) return;
    try {
      $(this).html(transformCSS(raw, targetUrl, proxyBase));
    } catch(e) { /* leave untransformed if it explodes */ }
  });

  // ── Remove elements that break old WebKit ─────────────────────
  // <link rel="preload"> / <link rel="modulepreload"> — causes errors
  $('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]').remove();
  // <link rel="manifest"> — not needed
  $('link[rel="manifest"]').remove();
  // <script type="module"> — old WebKit can't run ES modules at all
  // Convert to a no-op comment so dependent code doesn't throw reference errors
  safeEach($, 'script[type="module"]', function () {
    $(this).removeAttr('type').html('/* module script removed for 3DS compat */');
  });
  // Remove importmap — irrelevant without module support
  $('script[type="importmap"]').remove();

  // ── <picture> element — collapse to best <source> or <img> ───
  // 3DS WebKit has no <picture> support; pick the first non-webp/avif
  // source, or fall back to the <img> src inside it.
  safeEach($, 'picture', function () {
    const pic = $(this);
    let chosenSrc = null;
    // Try sources in order, skip modern formats the 3DS can't decode
    pic.find('source').each(function () {
      if (chosenSrc) return;
      const type = ($(this).attr('type') || '').toLowerCase();
      if (/avif|webp|jxl/.test(type)) return; // skip unsupported formats
      const srcset = $(this).attr('srcset') || $(this).attr('src') || '';
      if (srcset) {
        // Pick the first URL from srcset (lowest descriptor usually comes first)
        const firstUrl = srcset.trim().split(/,\s*/)[0].trim().split(/\s+/)[0];
        if (firstUrl) chosenSrc = firstUrl;
      }
    });
    // Fall back to <img src> inside the picture
    const img = pic.find('img');
    if (!chosenSrc) {
      chosenSrc = img.attr('src') || img.attr('data-src') || '';
    }
    if (chosenSrc && !chosenSrc.startsWith('data:')) {
      const abs = resolveUrl(targetUrl, chosenSrc);
      // Replace the whole <picture> with a plain proxied <img>
      const alt = img.attr('alt') || '';
      const cls = img.attr('class') || '';
      const style = img.attr('style') || '';
      pic.replaceWith(
        `<img src="${proxyBase}/resource?url=${encodeURIComponent(abs)}"` +
        (alt   ? ` alt="${alt.replace(/"/g,'&quot;')}"` : '') +
        (cls   ? ` class="${cls.replace(/"/g,'&quot;')}"` : '') +
        (style ? ` style="${style.replace(/"/g,'&quot;')}"` : '') +
        ` style="max-width:100%;height:auto;">`
      );
    } else {
      // No usable source found — just unwrap to the <img>
      pic.replaceWith(img);
    }
  });

  // ── Lazy-loading normalization ────────────────────────────────
  // 3DS WebKit has no native lazy loading. Move data-src/data-lazy etc.
  // to src so images actually appear.
  safeEach($, 'img[data-src]', function () {
    const lazy = $(this).attr('data-src');
    if (lazy && !lazy.startsWith('data:') && !($(this).attr('src') || '').match(/^https?:/)) {
      $(this).attr('src', resolveUrl(targetUrl, lazy));
    }
    $(this).removeAttr('data-src');
  });
  safeEach($, 'img[data-lazy-src]', function () {
    const lazy = $(this).attr('data-lazy-src');
    if (lazy && !lazy.startsWith('data:') && !($(this).attr('src') || '').match(/^https?:/)) {
      $(this).attr('src', resolveUrl(targetUrl, lazy));
    }
    $(this).removeAttr('data-lazy-src');
  });
  safeEach($, 'img[data-original]', function () {
    const lazy = $(this).attr('data-original');
    if (lazy && !lazy.startsWith('data:') && !($(this).attr('src') || '').match(/^https?:/)) {
      $(this).attr('src', resolveUrl(targetUrl, lazy));
    }
    $(this).removeAttr('data-original');
  });
  // Remove loading="lazy" — not supported, might interfere
  $('[loading]').removeAttr('loading');
  // Remove decoding="async" — not supported
  $('[decoding]').removeAttr('decoding');
  // Remove fetchpriority — not supported
  $('[fetchpriority]').removeAttr('fetchpriority');

  safeEach($, '[style]', function () {
    var style = $(this).attr('style') || '';
    // Parse inline style into declarations and run each through the downgrader
    var outDecls = [];
    var declParts = style.split(';');
    for (var dpi = 0; dpi < declParts.length; dpi++) {
      var part = declParts[dpi].trim();
      if (!part) continue;
      var colon = part.indexOf(':');
      if (colon < 0) continue;
      var iprop = part.slice(0, colon).trim().toLowerCase();
      var ival  = part.slice(colon + 1).trim();
      // Proxy url() inside value
      ival = ival.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, function(match, u) {
        if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('about:')) return match;
        return "url('" + proxyBase + "/resource?url=" + encodeURIComponent(resolveUrl(targetUrl, u)) + "')";
      });
      var fakeDecl = { type:'declaration', property: iprop, value: ival };
      try {
        var results = downgradeCSSProperty(fakeDecl, {});
        for (var ri2 = 0; ri2 < results.length; ri2++) {
          var r2 = results[ri2];
          if (r2 && r2.property && r2.value) outDecls.push(r2.property + ':' + r2.value);
        }
      } catch(e) {
        outDecls.push(iprop + ':' + ival);
      }
    }
    $(this).attr('style', outDecls.join(';'));
  });

  const srcAttrs = [
    ['img', 'src'],
    ['img', 'srcset'],
    ['input[type="image"]', 'src'],
    ['link[rel="icon"]', 'href'], ['link[rel="shortcut icon"]', 'href'],
    ['link[rel="apple-touch-icon"]', 'href'],
  ];
  for (const [sel, attr] of srcAttrs) {
    safeEach($, sel, function () {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:') || val.startsWith(proxyBase)) return;
      if (attr === 'srcset') {
        // srcset="url 1x, url 2x" — proxy each URL, keep descriptors
        const rw = val.split(',').map(part => {
          const pieces = part.trim().split(/\s+/);
          const u = pieces[0];
          const rest = pieces.slice(1);
          if (!u || u.startsWith('data:')) return part;
          return [`${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, u))}`, ...rest].join(' ');
        }).join(', ');
        $(this).attr(attr, rw);
      } else if (attr === 'href') {
        // favicon/touch-icon hrefs — proxy as resource
        $(this).attr(attr, `${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, val))}`);
      } else {
        $(this).attr(attr, `${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, val))}`);
      }
    });
  }

  safeEach($, 'iframe[src]', function () {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return;
    const abs = resolveUrl(targetUrl, src);

    // Detect and replace known video embeds with a native <video> player
    const ytMatch = abs.match(/(?:youtube\.com\/embed\/|youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    const vmMatch = abs.match(/(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d+)/);
    const dmMatch = abs.match(/(?:dailymotion\.com\/(?:embed\/video\/|video\/)|dai\.ly\/)([A-Za-z0-9]+)/);

    if (ytMatch) {
      const vid = ytMatch[1];
      const lowSrc  = `${proxyBase}/video?id=${encodeURIComponent(vid)}&src=youtube&quality=low`;
      const highSrc = `${proxyBase}/video?id=${encodeURIComponent(vid)}&src=youtube`;
      $(this).replaceWith(
        `<div class="proxy-video-wrap">` +
        `<video controls preload="none" poster="${proxyBase}/resource?url=${encodeURIComponent(`https://img.youtube.com/vi/${vid}/mqdefault.jpg`)}">` +
        `<source src="${lowSrc}" type="video/mp4" data-quality="low">` +
        `<source src="${highSrc}" type="video/mp4" data-quality="high">` +
        `<p><a href="${proxyBase}/proxy?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}">Watch on YouTube: ${vid}</a></p>` +
        `</video></div>`
      );
    } else if (vmMatch) {
      const vid = vmMatch[1];
      $(this).replaceWith(`<div class="proxy-video-wrap"><p style="color:#fff;padding:8px;font-size:12px;">Vimeo video (${vid})<br><a style="color:#8cf;" href="${proxyBase}/proxy?url=${encodeURIComponent(`https://vimeo.com/${vid}`)}">Open on Vimeo</a></p></div>`);
    } else if (dmMatch) {
      const vid = dmMatch[1];
      const lowSrc  = `${proxyBase}/video?id=${encodeURIComponent(vid)}&src=dailymotion&quality=low`;
      const highSrc = `${proxyBase}/video?id=${encodeURIComponent(vid)}&src=dailymotion`;
      $(this).replaceWith(
        `<div class="proxy-video-wrap">` +
        `<video controls preload="none">` +
        `<source src="${lowSrc}" type="video/mp4" data-quality="low">` +
        `<source src="${highSrc}" type="video/mp4" data-quality="high">` +
        `<p><a href="${proxyBase}/proxy?url=${encodeURIComponent(`https://www.dailymotion.com/video/${vid}`)}">Watch on Dailymotion: ${vid}</a></p>` +
        `</video></div>`
      );
    } else {
      $(this).attr('src', proxyUrl(abs, proxyBase));
    }
  });

  // Rewrite <video> sources — inject dual <source> tags for low/high quality.
  // The 3DS browser lists quality options based on the <source> elements present.
  // First source = low quality (smaller, faster); second = original pass-through.
  safeEach($, 'video', function () {
    const vid = $(this);
    const poster = vid.attr('poster');
    if (poster && !poster.startsWith('data:')) {
      vid.attr('poster', `${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, poster))}`);
    }
    vid.attr('controls', '');
    vid.attr('preload', 'none');

    // Collect all video source URLs from the src attribute and child <source> tags
    const srcUrls = [];
    const inlineSrc = vid.attr('src');
    if (inlineSrc && !inlineSrc.startsWith('data:')) {
      srcUrls.push(resolveUrl(targetUrl, inlineSrc));
      vid.removeAttr('src'); // will be replaced by <source> elements below
    }
    vid.find('source[src]').each(function () {
      const s = $(this).attr('src');
      if (s && !s.startsWith('data:')) srcUrls.push(resolveUrl(targetUrl, s));
      $(this).remove();
    });

    if (srcUrls.length === 0) {
      // No sources found — nothing to do
    } else {
      // Use the first URL as the canonical source
      const canonical = srcUrls[0];
      const lowSrc  = `${proxyBase}/video?url=${encodeURIComponent(canonical)}&quality=low`;
      const highSrc = `${proxyBase}/video?url=${encodeURIComponent(canonical)}`;
      // Prepend: low quality first so 3DS defaults to it; high quality second for the toggle
      vid.prepend(
        `<source src="${lowSrc}" type="video/mp4" data-quality="low">` +
        `<source src="${highSrc}" type="video/mp4" data-quality="high">`
      );
    }

    // Wrap in fluid container if not already
    if (!vid.parent().hasClass('proxy-video-wrap')) {
      vid.wrap('<div class="proxy-video-wrap"></div>');
    }
  });

  // Replace <object>/<embed> that look like video players
  safeEach($, 'object[data]', function () {
    const data = $(this).attr('data') || '';
    const type = $(this).attr('type') || '';
    if (/video|flash|swf/i.test(type + data)) {
      $(this).replaceWith(`<div class="proxy-video-wrap" style="background:#222;"><p style="color:#aaa;padding:8px;font-size:11px;">Flash/object video not supported.<br><a style="color:#8cf;" href="${proxyBase}/proxy?url=${encodeURIComponent(resolveUrl(targetUrl, data))}">Try direct link</a></p></div>`);
    }
  });
  safeEach($, 'embed[src]', function () {
    const src = $(this).attr('src') || '';
    const type = $(this).attr('type') || '';
    if (/video|flash|swf/i.test(type + src)) {
      $(this).replaceWith(`<div class="proxy-video-wrap" style="background:#222;"><p style="color:#aaa;padding:8px;font-size:11px;">Flash/embed video not supported.<br><a style="color:#8cf;" href="${proxyBase}/proxy?url=${encodeURIComponent(resolveUrl(targetUrl, src))}">Try direct link</a></p></div>`);
    }
  });

  // Polished recovery stylesheet — injected LAST so it wins specificity battles.
  // Goals: fix broken grid/flex layouts, ensure readable typography, make links
  // and buttons look like interactive elements, not just blue text.
  $('body').append(`<style>
/* ── Box model reset ───────────────────────────────────────── */
*{-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box;}
html,body{width:100%!important;max-width:100%!important;overflow-x:hidden!important;
  margin:0!important;padding:0!important;word-wrap:break-word;word-break:break-word;}
body{padding:6px!important;line-height:1.5;}

/* ── Typography baseline ───────────────────────────────────── */
body,input,select,textarea,button{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222;}
h1{font-size:20px;margin:10px 0 6px;}
h2{font-size:17px;margin:9px 0 5px;}
h3{font-size:15px;margin:8px 0 4px;}
h4,h5,h6{font-size:13px;margin:6px 0 3px;}
h1,h2,h3,h4,h5,h6{line-height:1.3;font-weight:bold;}
p{margin:6px 0;}

/* ── Links ─────────────────────────────────────────────────── */
a{color:#0055cc;text-decoration:underline;}
a:visited{color:#551a8b;}
a:hover,a:focus{color:#0033aa;text-decoration:underline;}

/* ── Images & media ────────────────────────────────────────── */
img,video,canvas,svg,object,embed{max-width:100%!important;height:auto!important;display:inline-block;}
img{vertical-align:middle;}
figure{margin:6px 0;}
figcaption{font-size:11px;color:#555;margin-top:2px;}

/* ── Tables ────────────────────────────────────────────────── */
table{width:100%!important;max-width:100%!important;border-collapse:collapse;
  word-wrap:break-word;table-layout:fixed;margin:6px 0;}
td,th{word-wrap:break-word;overflow:hidden;padding:4px 5px;
  border:1px solid #ddd;vertical-align:top;text-align:left;}
th{background:#f0f0f0;font-weight:bold;}
tr:nth-child(even) td{background:#f9f9f9;}

/* ── Code & pre ────────────────────────────────────────────── */
pre,code,kbd,samp{white-space:pre-wrap!important;word-wrap:break-word!important;
  max-width:100%!important;overflow-x:auto;font-family:monospace;font-size:11px;}
pre{background:#f4f4f4;border:1px solid #ddd;padding:6px;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;}
code{background:#f0f0f0;padding:1px 3px;-webkit-border-radius:2px;border-radius:2px;}
pre code{background:none;padding:0;border-radius:0;}

/* ── Forms ─────────────────────────────────────────────────── */
input,select,textarea,button{max-width:100%!important;font-size:13px;
  -webkit-box-sizing:border-box;box-sizing:border-box;}
input[type=text],input[type=search],input[type=email],input[type=url],
input[type=password],input[type=number],textarea,select{
  display:inline-block;padding:5px 6px;border:1px solid #aaa;
  -webkit-border-radius:3px;border-radius:3px;background:#fff;
  width:auto;max-width:100%;vertical-align:middle;}
input[type=submit],input[type=button],input[type=reset],button{
  display:inline-block;padding:5px 12px;cursor:pointer;
  background:#e8e8e8;border:1px solid #aaa;
  -webkit-border-radius:3px;border-radius:3px;
  color:#222;font-size:13px;text-align:center;}
input[type=submit]:active,button:active{background:#d0d0d0;}
label{display:inline-block;margin-bottom:2px;}
fieldset{border:1px solid #bbb;padding:6px;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;}
legend{font-weight:bold;padding:0 4px;}

/* ── Lists ─────────────────────────────────────────────────── */
ul,ol{padding-left:22px;margin:6px 0;}
li{margin:2px 0;}
dl{margin:6px 0;}
dt{font-weight:bold;}
dd{margin-left:16px;margin-bottom:3px;}

/* ── Blockquote & HR ───────────────────────────────────────── */
blockquote{margin:8px 4px;padding:4px 10px;border-left:3px solid #aaa;
  color:#444;background:#f8f8f8;}
hr{border:0;border-top:1px solid #ccc;margin:10px 0;}

/* ── Position fixes ────────────────────────────────────────── */
[style*="position:fixed"],[style*="position: fixed"]{position:absolute!important;}

/* ── Grid recovery — children of broken grid containers ───── */
/* When grid-template-columns is stripped, children collapse.
   Float-based column restoration: elements with data-cols attr
   set by the proxy, or inline-block for nav/menu children.    */
nav ul,nav ol{padding:0;margin:0;list-style:none;}
nav li{display:inline-block;margin:0 4px 4px 0;}
nav li a{padding:3px 8px;text-decoration:none;background:#eee;
  display:inline-block;-webkit-border-radius:3px;border-radius:3px;}

/* Common flex/grid container patterns — make them wrap nicely */
[class*="flex"],[class*="grid"],[class*="row"],[class*="columns"]{
  overflow:hidden;}
[class*="flex"] > *,[class*="grid"] > *,[class*="row"] > *{
  max-width:100%;word-wrap:break-word;}

/* Cards and panels */
[class*="card"],[class*="panel"],[class*="tile"],[class*="box"]{
  border:1px solid #ddd;padding:8px;margin:6px 0;background:#fff;
  -webkit-border-radius:4px;border-radius:4px;display:block;
  -webkit-box-shadow:0 1px 3px rgba(0,0,0,0.1);box-shadow:0 1px 3px rgba(0,0,0,0.1);}

/* Buttons with class names */
[class*="btn"],[class*="button"]{
  display:inline-block!important;padding:5px 12px!important;
  border:1px solid #aaa!important;-webkit-border-radius:3px!important;
  border-radius:3px!important;background:#e8e8e8!important;
  color:#222!important;text-decoration:none!important;
  font-size:13px!important;cursor:pointer!important;}

/* Badges, tags, pills */
[class*="badge"],[class*="tag"],[class*="pill"],[class*="chip"]{
  display:inline-block;padding:2px 7px;-webkit-border-radius:10px;
  border-radius:10px;background:#ddd;color:#333;font-size:11px;
  border:1px solid #bbb;margin:1px;}

/* Common hero / banner containers */
[class*="hero"],[class*="banner"],[class*="jumbotron"]{
  padding:12px 8px!important;margin:0 0 8px!important;}

/* Avoid invisible text on white backgrounds — reset dark mode vars */
[class*="dark"],[class*="theme"]{color:#222!important;background:#fff!important;}

/* ── Fluid video container ─────────────────────────────────── */
.proxy-video-wrap{position:relative;width:100%;padding-bottom:56.25%;height:0;
  overflow:hidden;background:#111;margin:6px 0;
  -webkit-border-radius:3px;border-radius:3px;}
.proxy-video-wrap video,.proxy-video-wrap iframe{
  position:absolute;top:0;left:0;width:100%!important;height:100%!important;border:0;}

/* ── Narrow-screen tweaks for 3DS (320px top screen) ──────── */
@media screen and (max-width:340px){
  body{font-size:12px!important;padding:3px!important;}
  h1{font-size:16px;}h2{font-size:14px;}h3,h4,h5,h6{font-size:12px;}
  td,th{font-size:11px;padding:2px 3px;}
  input,select,textarea,button{font-size:12px;}
  pre,code{font-size:10px;}
  [class*="btn"],[class*="button"]{padding:4px 8px!important;font-size:12px!important;}
}
</style>`);

  return $.html();
}

// ─── AXIOS HELPER ────────────────────────────────────────────────
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
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 15000,
    decompress: true
  });
}

// ─── HOME ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3DS Proxy</title>
<style>
body{font-family:sans-serif;padding:10px;background:#dde;width:100%;max-width:600px;margin:0 auto;-webkit-box-sizing:border-box;box-sizing:border-box;}
h2{color:#336;font-size:16px;}
input[name=q]{width:72%;padding:4px;font-size:13px;}
input[type=submit]{padding:4px 8px;font-size:13px;}
small{color:#555;font-size:11px;}
@media screen and (max-width:340px){input[name=q]{width:62%;font-size:12px;}}
</style>
</head><body>
<h2>3DS Web Proxy</h2>
<form method="GET" action="/go">
<input name="q" placeholder="URL or search term">
<input type="submit" value="Go">
</form>
<br><small>Type a URL like <b>example.com</b> or search terms.<br>Search via DuckDuckGo Lite.</small>
</body></html>`);
});

// ─── SMART GO ────────────────────────────────────────────────────
app.get('/go', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');
  if (/^https?:\/\//i.test(q) || /^[\w-]+\.\w{2,}(\/|$)/.test(q))
    return res.redirect(`/proxy?url=${encodeURIComponent(/^https?:\/\//i.test(q) ? q : 'http://'+q)}`);
  return res.redirect(`/search?q=${encodeURIComponent(q)}`);
});

// ─── PROXY ───────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  let targetUrl = (req.query.url || '').trim();
  if (!targetUrl) return res.redirect('/');
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'http://' + targetUrl;
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const response = await proxyFetch(targetUrl);
    if (response.status >= 300 && response.status < 400 && response.headers.location)
      return res.redirect(`/proxy?url=${encodeURIComponent(resolveUrl(targetUrl, response.headers.location))}`);
    const ct = (response.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      try { res.send(transformHTML(response.data.toString('utf-8'), targetUrl, proxyBase)); }
      catch (e) { res.send(`<!-- transform error: ${e.message} -->\n` + response.data.toString('utf-8')); }
    } else if (ct.includes('text/css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.send(transformCSS(response.data.toString('utf-8'), targetUrl, proxyBase));
    } else if (ct.includes('javascript')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.send(transformJS(response.data.toString('utf-8'), proxyBase));
    } else if (ct.includes('video/') || ct.includes('application/x-mpegurl') || ct.includes('application/vnd.apple.mpegurl')) {
      // Redirect video streams through the video proxy for range-request support
      res.redirect(`/video?url=${encodeURIComponent(targetUrl)}`);
    } else {
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      res.send(response.data);
    }
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<html><body><h3>Proxy error</h3><p>${err.message}</p><a href="/">Back</a></body></html>`);
  }
});

// ─── SEARCH ──────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/');
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const data = await fetchSearch(q);
    const results = (data.results || []).slice(0, 10);
    let html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Search: ${q}</title>
<style>body{font-family:sans-serif;padding:8px;background:#f5f5f5;font-size:13px;width:100%;max-width:600px;margin:0 auto;-webkit-box-sizing:border-box;box-sizing:border-box;}
h3{color:#336;font-size:13px;margin:4px 0;}.r{margin-bottom:8px;padding:5px;background:#fff;border:1px solid #ccc;}
.r a{color:#00c;font-size:13px;}.r small{color:#080;display:block;font-size:10px;word-break:break-all;}
.r p{margin:2px 0;color:#333;font-size:11px;}form{margin-bottom:6px;}input[name=q]{width:70%;font-size:12px;}
@media screen and (max-width:340px){input[name=q]{width:55%;}}
</style>
</head><body>
<form method="GET" action="/search"><input name="q" value="${q.replace(/"/g,'&quot;')}"><input type="submit" value="Search"> | <a href="/">Home</a></form>
<h3>Results for &quot;${q}&quot;</h3>`;
    results.length
      ? results.forEach(r => {
          const title = (r.title||r.url||'').replace(/</g,'&lt;');
          const snip = (r.content||'').replace(/</g,'&lt;').substring(0,180);
          html += `<div class="r"><a href="${proxyBase}/proxy?url=${encodeURIComponent(r.url)}">${title}</a>
<small>${r.url.substring(0,70)}</small>${snip?`<p>${snip}</p>`:''}</div>`;
        })
      : (html += '<p>No results.</p>');
    html += '</body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<html><body><h3>Search failed</h3><p>${e.message}</p>
<a href="/proxy?url=${encodeURIComponent('https://lite.duckduckgo.com/lite/?q='+encodeURIComponent(q))}">Try DDG Lite directly</a> | <a href="/">Home</a></body></html>`);
  }
});

// ─── /ask ────────────────────────────────────────────────────────
app.get('/ask', (req, res) => res.redirect(`/search?q=${encodeURIComponent(req.query.q||req.query.query||'')}`));

// ─── GET FORM ────────────────────────────────────────────────────
app.get('/form-get', async (req, res) => {
  const targetUrl = req.query.__proxy_url;
  if (!targetUrl) return res.redirect('/');
  const params = Object.assign({}, req.query);
  delete params.__proxy_url;
  try {
    const u = new urlModule.URL(targetUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return res.redirect(`/proxy?url=${encodeURIComponent(u.href)}`);
  } catch {
    const qs = new urlModule.URLSearchParams(params).toString();
    return res.redirect(`/proxy?url=${encodeURIComponent(targetUrl+(qs?(targetUrl.includes('?')?'&':'?')+qs:''))}`);
  }
});

// ─── POST FORM ───────────────────────────────────────────────────
app.use('/form-post', express.urlencoded({ extended: true }));
app.use('/form-post', express.json());
app.all('/form-post', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.redirect('/');
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const response = await proxyFetch(targetUrl, { method: req.method, data: req.body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (response.status >= 300 && response.status < 400 && response.headers.location)
      return res.redirect(`/proxy?url=${encodeURIComponent(resolveUrl(targetUrl, response.headers.location))}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(transformHTML(response.data.toString('utf-8'), targetUrl, proxyBase));
  } catch { res.send('Form submission failed'); }
});

// ─── CSS ─────────────────────────────────────────────────────────
app.get('/css', async (req, res) => {
  if (!req.query.url) return res.send('');
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const r = await axios.get(req.query.url, { headers: { 'User-Agent': MODERN_UA }, timeout: 10000, validateStatus: () => true });
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.send(transformCSS(r.data, req.query.base || req.query.url, proxyBase));
  } catch { res.send('/* css fetch failed */'); }
});

// ─── JS ──────────────────────────────────────────────────────────
app.get('/js', async (req, res) => {
  if (!req.query.url) return res.send('');
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  try {
    const r = await axios.get(req.query.url, { headers: { 'User-Agent': MODERN_UA }, timeout: 10000, validateStatus: () => true });
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(transformJS(r.data.toString(), proxyBase));
  } catch { res.send('/* js fetch failed */'); }
});

// ─── VIDEO PROXY ─────────────────────────────────────────────────
// True pass-through for direct video URLs with range-request support.
// Optional low-quality transcode: append &quality=low to any /video URL.
//   /video?url=<direct_video_url>              — pass-through (original quality)
//   /video?url=<direct_video_url>&quality=low  — ffmpeg transcode to 240p
//   /video?id=<youtube_id>&src=youtube         — YouTube via ytdl-core
//   /video?id=<dailymotion_id>&src=dailymotion — Dailymotion lowest stream
//
// Low-quality transcode requires ffmpeg on PATH: apt install ffmpeg
// If ffmpeg is missing the route falls back to pass-through automatically.

// Detect ffmpeg availability once at startup
const { execFile, spawn } = require('child_process');
let ffmpegAvailable = false;
execFile('ffmpeg', ['-version'], { timeout: 3000 }, err => {
  ffmpegAvailable = !err;
  if (ffmpegAvailable) console.log('[proxy] ffmpeg found — low-quality transcode enabled');
  else                 console.warn('[proxy] ffmpeg not found — low-quality transcode disabled (install with: apt install ffmpeg)');
});

app.get('/video', async (req, res) => {
  const directUrl = (req.query.url || '').trim();
  const id        = (req.query.id  || '').trim();
  const src       = (req.query.src || '').toLowerCase();
  const wantLow   = (req.query.quality || '').toLowerCase() === 'low';

  try {
    // ── YouTube via ytdl-core ──────────────────────────────────
    if ((src === 'youtube' || (!directUrl && !src)) && (id || req.query.ytid)) {
      const ytId = id || req.query.ytid;
      if (!ytdl) {
        return res.status(503).send(`<html><body><p>YouTube video streaming requires <b>ytdl-core</b>.<br>Run: <code>npm install ytdl-core</code></p><a href="/">Back</a></body></html>`);
      }
      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const info = await ytdl.getInfo(videoUrl);
      // For low quality pick ≤240p combined, otherwise lowest combined available
      const format = wantLow
        ? (ytdl.chooseFormat(info.formats, {
            quality: 'lowest',
            filter: f => f.hasVideo && f.hasAudio &&
              (f.qualityLabel === '240p' || f.qualityLabel === '144p' || f.quality === 'small')
          }) || ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' }))
        : ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' })
          || ytdl.chooseFormat(info.formats, { quality: 'lowest', filter: 'audioandvideo' });

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      ytdl(videoUrl, { format }).pipe(res);
      return;
    }

    // ── Dailymotion: fetch manifest and return lowest stream ───
    if (src === 'dailymotion' && id) {
      const apiUrl = `https://www.dailymotion.com/player/metadata/video/${id}`;
      const meta = await axios.get(apiUrl, { headers: { 'User-Agent': MODERN_UA }, timeout: 10000, validateStatus: () => true });
      let streamUrl = null;
      if (meta.data && meta.data.qualities) {
        // Low quality: prefer 240/144; high quality: prefer 380/720/auto
        const prios = wantLow ? ['240', '144', '380', 'auto'] : ['720', '480', '380', '240', 'auto'];
        for (const p of prios) {
          const bucket = meta.data.qualities[p];
          if (bucket && bucket[0] && bucket[0].url) { streamUrl = bucket[0].url; break; }
        }
      }
      if (!streamUrl) {
        return res.status(404).send('<html><body><p>Dailymotion stream not found.</p><a href="/">Back</a></body></html>');
      }
      return res.redirect(streamUrl);
    }

    // ── Direct video URL ───────────────────────────────────────
    // Strategy: redirect directly to the video URL (302).
    // The 3DS <video> element follows redirects natively, and this avoids
    // Render's streaming timeouts entirely — no bytes need to flow through
    // the proxy server for the video itself.
    // If quality=low and ffmpeg is available, transcode instead.
    if (directUrl) {
      if (wantLow && ffmpegAvailable) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-cache');
        const ff = spawn('ffmpeg', [
          '-user_agent', MODERN_UA,
          '-i', directUrl,
          '-vf', 'scale=426:-2',
          '-c:v', 'libx264',
          '-profile:v', 'baseline',
          '-level', '3.0',
          '-b:v', '200k',
          '-maxrate', '250k',
          '-bufsize', '400k',
          '-c:a', 'aac',
          '-b:a', '48k',
          '-ar', '22050',
          '-ac', '1',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-movflags', 'frag_keyframe+empty_moov+faststart',
          '-f', 'mp4',
          'pipe:1'
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        ff.stdout.pipe(res);
        res.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
        ff.on('error', err => {
          console.error('[video/ffmpeg] spawn error:', err.message);
          if (!res.headersSent) res.status(500).send('ffmpeg error');
        });
        return;
      }

      // Redirect directly to the video — zero Render overhead.
      return res.redirect(302, directUrl);
    }

    res.status(400).send('<html><body><p>No video source specified.</p><a href="/">Back</a></body></html>');
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<html><body><h3>Video error</h3><p>${err.message}</p><a href="/">Back</a></body></html>`);
    }
  }
});

// ─── RESOURCE ────────────────────────────────────────────────────
app.get('/resource', async (req, res) => {
  if (!req.query.url) return res.end();
  try {
    const r = await axios.get(req.query.url, { responseType: 'arraybuffer', headers: { 'User-Agent': MODERN_UA }, timeout: 15000, validateStatus: () => true });
    res.setHeader('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.data);
  } catch { res.end(); }
});

// ─── CATCH-ALL ───────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const match = (req.headers.referer || '').match(/[?&]url=([^&]+)/);
  if (match) {
    try {
      const origin = new urlModule.URL(decodeURIComponent(match[1]));
      return res.redirect(`/proxy?url=${encodeURIComponent(`${origin.protocol}//${origin.host}${req.url}`)}`);
    } catch {}
  }
  res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<html><body><h3>Not found</h3><p><code>${req.url}</code></p><a href="/">Home</a></body></html>`);
});

// ─── START ───────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`3DS Proxy running on port ${PORT}`));
