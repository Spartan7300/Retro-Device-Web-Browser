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

// ─── CSS DOWNGRADE HELPERS ──────────────────────────────────────

function downgradeCSSValue(prop, value) {
  // rgba → rgb (drop alpha)
  value = value.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,[^)]+\)/gi,
    (m, r, g, b) => `rgb(${r},${g},${b})`);
  // hsla → hsl
  value = value.replace(/hsla\(([^,]+,[^,]+,[^,]+),[^)]+\)/gi,
    (m, inner) => `hsl(${inner})`);
  // CSS variables → fallback or inherit
  value = value.replace(/var\(--[\w-]+(?:\s*,\s*([^)]+))?\)/gi,
    (m, fb) => fb ? fb.trim() : 'inherit');
  // calc() — attempt simple same-unit collapse
  value = value.replace(/calc\(([^)]+)\)/gi, (m, expr) => {
    try {
      const su = expr.match(/^([\d.]+)(px|em|rem|%)\s*([+\-])\s*([\d.]+)\2$/);
      if (su) { const v = su[3]==='+' ? +su[1]+ +su[4] : +su[1]- +su[4]; return `${v}${su[2]}`; }
      const pn = expr.match(/^([\d.]+)\s*([+\-\*\/])\s*([\d.]+)$/);
      if (pn) { const a=+pn[1],op=pn[2],b=+pn[3]; return String(op==='+'?a+b:op==='-'?a-b:op==='*'?a*b:b?a/b:a); }
    } catch {}
    return m;
  });
  // clamp(min,val,max) → val
  value = value.replace(/clamp\(\s*[^,]+,\s*([^,]+),\s*[^)]+\)/gi, (m, val) => val.trim());
  // min(a,b) → a
  value = value.replace(/\bmin\(\s*([^,)]+),[^)]+\)/gi, (m, a) => a.trim());
  // max(a,b) → b
  value = value.replace(/\bmax\([^,]+,\s*([^)]+)\)/gi, (m, b) => b.trim());
  // gradients → first colour stop
  value = value.replace(/(?:linear|radial|conic)-gradient\([^)]*?,\s*(#[\da-fA-F]{3,8}|rgba?[^,)]+|[a-zA-Z]+)[^)]*\)/gi,
    (m, c) => c || '#ccc');
  // env() → fallback or 0
  value = value.replace(/env\(\s*[\w-]+(?:\s*,\s*([^)]+))?\)/gi, (m, fb) => fb ? fb.trim() : '0');
  // fit-content / min-content / max-content → auto
  value = value.replace(/fit-content\([^)]*\)/gi, 'auto');
  value = value.replace(/\b(?:min|max)-content\b/gi, 'auto');
  // color() → #000
  value = value.replace(/color\([^)]+\)/gi, '#000');
  return value;
}

function downgradeCSSProperty(decl) {
  const prop = (decl.property || '').toLowerCase();
  let val = downgradeCSSValue(prop, decl.value || '');

  // display:grid → block
  if (prop === 'display' && val.includes('grid')) return [{ type:'declaration', property:'display', value:'block' }];

  // display:flex → -webkit-box + flex
  if (prop === 'display' && (val === 'flex' || val === 'inline-flex')) {
    return [
      { type:'declaration', property:'display', value:'-webkit-box' },
      { type:'declaration', property:'display', value:val }
    ];
  }

  // Flexbox axis
  if (prop === 'flex-direction') {
    const isCol = val.includes('column'), isRev = val.includes('reverse');
    return [
      { type:'declaration', property:'-webkit-box-orient', value: isCol?'vertical':'horizontal' },
      { type:'declaration', property:'-webkit-box-direction', value: isRev?'reverse':'normal' },
      { type:'declaration', property:'flex-direction', value:val }
    ];
  }
  if (prop === 'align-items') {
    const m = {center:'center','flex-start':'start','flex-end':'end',stretch:'stretch',baseline:'baseline'};
    return [{ type:'declaration', property:'-webkit-box-align', value: m[val]||val },
            { type:'declaration', property:'align-items', value:val }];
  }
  if (prop === 'justify-content') {
    const m = {center:'center','flex-start':'start','flex-end':'end','space-between':'justify','space-around':'justify'};
    return [{ type:'declaration', property:'-webkit-box-pack', value: m[val]||val },
            { type:'declaration', property:'justify-content', value:val }];
  }
  if (prop === 'flex' || prop === 'flex-grow') {
    const n = parseFloat(val)||1;
    return [{ type:'declaration', property:'-webkit-box-flex', value:String(n) },
            { type:'declaration', property:prop, value:val }];
  }
  if (prop === 'order') {
    return [{ type:'declaration', property:'-webkit-box-ordinal-group', value:String((parseInt(val)||0)+1) },
            { type:'declaration', property:'order', value:val }];
  }

  // webkit-prefix pairs
  const wkPairs = [
    'border-radius','border-top-left-radius','border-top-right-radius',
    'border-bottom-left-radius','border-bottom-right-radius',
    'box-shadow','transform','transform-origin','transform-style',
    'transition','transition-property','transition-duration','transition-timing-function','transition-delay',
    'animation','animation-name','animation-duration','animation-timing-function',
    'animation-iteration-count','animation-fill-mode','animation-direction','animation-play-state','animation-delay',
    'appearance','user-select','backface-visibility','filter',
    'columns','column-count','column-gap','column-rule','column-span','column-width',
    'text-size-adjust','font-smoothing','tap-highlight-color',
  ];
  if (wkPairs.includes(prop)) {
    return [
      { type:'declaration', property:`-webkit-${prop}`, value:val },
      { type:'declaration', property:prop, value:val }
    ];
  }

  // position:sticky → -webkit-sticky + relative fallback
  if (prop === 'position' && val === 'sticky') {
    return [
      { type:'declaration', property:'position', value:'-webkit-sticky' },
      { type:'declaration', property:'position', value:'relative' }
    ];
  }
  // overflow:overlay → auto
  if (prop === 'overflow' && val === 'overlay') return [{ type:'declaration', property:'overflow', value:'auto' }];

  // text-decoration shorthand — strip color/style extra tokens old webkit chokes on
  if (prop === 'text-decoration') {
    const first = val.split(/\s+/)[0];
    if (['underline','overline','line-through','none'].includes(first)) {
      return [{ type:'declaration', property:'text-decoration', value:first }];
    }
  }

  // Drop properties 3DS WebKit cannot handle at all
  const drop = [
    'backdrop-filter','grid-template','grid-template-columns','grid-template-rows',
    'grid-template-areas','grid-area','grid-column','grid-row','grid-auto-flow',
    'grid-auto-columns','grid-auto-rows','gap','row-gap',
    'contain','will-change','isolation','mix-blend-mode',
    'overscroll-behavior','overscroll-behavior-x','overscroll-behavior-y',
    'scroll-snap-type','scroll-snap-align','scroll-padding','scroll-margin',
    'object-fit','object-position','font-display','font-variation-settings',
    'font-feature-settings','font-kerning','font-optical-sizing',
    'font-variant-ligatures','font-variant-numeric','font-variant-caps',
    'text-decoration-color','text-decoration-style','text-decoration-thickness',
    'text-underline-offset','text-overflow-mode',
    'paint-order','shape-outside','shape-margin',
    'counter-set','list-style-type',  // keep list-style-type? actually fine, leave it
  ];
  // Re-allow list-style-type
  const dropSet = new Set(drop.filter(d => d !== 'list-style-type'));
  if (dropSet.has(prop)) return [];

  // grid-* wildcard
  if (prop.startsWith('grid-')) return [];

  decl.value = val;
  return [decl];
}

function processRules(rules) {
  if (!rules) return [];
  const out = [];
  for (const rule of rules) {
    if (!rule) continue;

    if (rule.type === 'rule') {
      if (rule.selectors) {
        rule.selectors = rule.selectors.map(s => {
          s = s.replace(/:root\b/g, 'html');
          s = s.replace(/:is\(([^)]+)\)/g, (m, a) => a.split(',')[0].trim());
          s = s.replace(/:where\(([^)]+)\)/g, (m, a) => a.split(',')[0].trim());
          if (s.includes(':has(')) return null;
          s = s.replace(/:not\(([^)]+)\)/g, (m, inner) =>
            /^[a-zA-Z.#*[\]="'-]+$/.test(inner) ? `:not(${inner})` : '');
          s = s.replace(/:focus-visible\b/g, ':focus');
          s = s.replace(/:focus-within\b/g, ':focus');
          s = s.replace(/::before\b/g, ':before');
          s = s.replace(/::after\b/g, ':after');
          s = s.replace(/::first-line\b/g, ':first-line');
          s = s.replace(/::first-letter\b/g, ':first-letter');
          s = s.replace(/::selection\b/g, '::-webkit-selection');
          s = s.replace(/::placeholder\b/g, '::-webkit-input-placeholder');
          s = s.replace(/::placeholder-shown\b/g, '');
          s = s.replace(/^&\s*/, '');
          return s.trim() || null;
        }).filter(Boolean);
        if (!rule.selectors.length) continue;
      }
      const newDecls = [];
      for (const d of (rule.declarations || [])) {
        if (!d || d.type !== 'declaration') { newDecls.push(d); continue; }
        for (const nd of downgradeCSSProperty(d)) newDecls.push(nd);
      }
      rule.declarations = newDecls;
      out.push(rule);

    } else if (rule.type === 'keyframes') {
      if (rule.keyframes) {
        for (const kf of rule.keyframes) {
          const nd = [];
          for (const d of (kf.declarations || [])) {
            if (!d || d.type !== 'declaration') { nd.push(d); continue; }
            for (const x of downgradeCSSProperty(d)) nd.push(x);
          }
          kf.declarations = nd;
        }
      }
      out.push({ type:'keyframes', name:rule.name, vendor:'-webkit-', keyframes:rule.keyframes });
      out.push(rule);

    } else if (rule.type === 'media') {
      const mq = (rule.media || '').toLowerCase();
      if (/prefers-color-scheme|prefers-reduced-motion|hover|pointer|display-mode|prefers-contrast|forced-colors/.test(mq)) continue;
      rule.media = rule.media.replace(/([\d.]+)rem/g, (m, n) => `${Math.round(parseFloat(n)*16)}px`);
      rule.rules = processRules(rule.rules);
      out.push(rule);

    } else if (rule.type === 'supports') {
      // Flatten @supports — just emit the inner rules unconditionally
      for (const r of processRules(rule.rules)) out.push(r);

    } else if (rule.type === 'font-face') {
      const nd = [];
      for (const d of (rule.declarations || [])) {
        if (!d || d.type !== 'declaration') { nd.push(d); continue; }
        if (['font-display','font-variation-settings'].includes(d.property)) continue;
        nd.push(d);
      }
      rule.declarations = nd;
      out.push(rule);

    } else {
      out.push(rule);
    }
  }
  return out;
}

function transformCSS(rawCss, baseUrl, proxyBase) {
  // Proxy url() references
  rawCss = rawCss.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('#')) return match;
    return `url('${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(baseUrl, u))}')`;
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
  try {
    const ast = css.parse(rawCss, { silent: true });
    if (ast && ast.stylesheet) ast.stylesheet.rules = processRules(ast.stylesheet.rules);
    return css.stringify(ast, { compress: false });
  } catch { return rawCss; }
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
    `<meta name="viewport" content="width=400">\n` +
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

  safeEach($, '[style]', function () {
    const style = $(this).attr('style') || '';
    const rw = style
      .replace(/var\(--[\w-]+(?:\s*,\s*([^)]+))?\)/gi, (m, fb) => fb ? fb.trim() : 'inherit')
      .replace(/rgba\((\d+),\s*(\d+),\s*(\d+),[^)]+\)/gi, 'rgb($1,$2,$3)')
      .replace(/calc\([^)]+\)/gi, 'auto')
      .replace(/clamp\([^)]+\)/gi, 'auto')
      .replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, u) => {
        if (u.startsWith('data:') || u.startsWith('#')) return match;
        return `url('${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, u))}')`;
      });
    $(this).attr('style', rw);
  });

  const srcAttrs = [
    ['img', 'src'], ['img', 'data-src'], ['img', 'data-lazy-src'],
    ['source', 'src'], ['source', 'srcset'],
    ['video', 'src'], ['video', 'poster'],
    ['audio', 'src'], ['track', 'src'],
    ['input[type="image"]', 'src']
  ];
  for (const [sel, attr] of srcAttrs) {
    safeEach($, sel, function () {
      const val = $(this).attr(attr);
      if (!val || val.startsWith('data:')) return;
      if (attr === 'srcset') {
        const rw = val.split(',').map(part => {
          const [u, ...rest] = part.trim().split(/\s+/);
          return [`${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, u))}`, ...rest].join(' ');
        }).join(', ');
        $(this).attr(attr, rw);
      } else {
        $(this).attr(attr, `${proxyBase}/resource?url=${encodeURIComponent(resolveUrl(targetUrl, val))}`);
      }
    });
  }

  safeEach($, 'iframe[src]', function () {
    const src = $(this).attr('src');
    if (!src || src.startsWith('data:') || src.startsWith('javascript:')) return;
    $(this).attr('src', proxyUrl(resolveUrl(targetUrl, src), proxyBase));
  });

  // 3DS layout normalizer — appended after all page content
  $('body').append(`<style>
*{-webkit-box-sizing:border-box;-moz-box-sizing:border-box;box-sizing:border-box;}
body{max-width:400px!important;overflow-x:hidden!important;margin:0 auto!important;word-wrap:break-word;}
img,video,canvas,svg,object,embed{max-width:100%!important;height:auto!important;}
table{max-width:100%!important;word-wrap:break-word;table-layout:fixed;}
td,th{word-wrap:break-word;overflow:hidden;}
pre,code,kbd,samp{white-space:pre-wrap!important;word-wrap:break-word!important;max-width:100%!important;overflow-x:auto;}
input,select,textarea,button{max-width:100%!important;}
[style*="position:fixed"],[style*="position: fixed"]{position:absolute!important;}
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
<meta name="viewport" content="width=400">
<title>3DS Proxy</title>
<style>
body{font-family:sans-serif;padding:10px;background:#dde;max-width:400px;}
h2{color:#336;font-size:16px;}
input[name=q]{width:72%;padding:4px;font-size:13px;}
input[type=submit]{padding:4px 8px;font-size:13px;}
small{color:#555;font-size:11px;}
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
<meta name="viewport" content="width=400">
<title>Search: ${q}</title>
<style>body{font-family:sans-serif;padding:8px;background:#f5f5f5;font-size:13px;max-width:400px;}
h3{color:#336;font-size:13px;margin:4px 0;}.r{margin-bottom:8px;padding:5px;background:#fff;border:1px solid #ccc;}
.r a{color:#00c;font-size:13px;}.r small{color:#080;display:block;font-size:10px;word-break:break-all;}
.r p{margin:2px 0;color:#333;font-size:11px;}form{margin-bottom:6px;}input[name=q]{width:70%;font-size:12px;}</style>
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
