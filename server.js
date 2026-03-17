(function () {
  const PROXY_PREFIX = "/proxy?url=";

  function rewriteUrl(url) {
    try {
      if (!url) return url;

      // Ignore already proxied
      if (url.startsWith(PROXY_PREFIX)) return url;

      // Ignore special schemes
      if (
        url.startsWith("javascript:") ||
        url.startsWith("data:") ||
        url.startsWith("mailto:") ||
        url.startsWith("tel:")
      ) return url;

      const absolute = new URL(url, location.href);
      return PROXY_PREFIX + encodeURIComponent(absolute.href);
    } catch {
      return url;
    }
  }

  // -------------------------
  // Rewrite DOM attributes
  // -------------------------
  function rewriteAttributes(root = document) {
    const ATTRS = [
      ["a", "href"],
      ["link", "href"],
      ["img", "src"],
      ["script", "src"],
      ["iframe", "src"],
      ["form", "action"],
      ["source", "src"],
      ["video", "src"],
      ["audio", "src"],
    ];

    ATTRS.forEach(([tag, attr]) => {
      root.querySelectorAll(`${tag}[${attr}]`).forEach(el => {
        const val = el.getAttribute(attr);
        if (val) {
          el.setAttribute(attr, rewriteUrl(val));
        }
      });
    });
  }

  // -------------------------
  // Intercept clicks
  // -------------------------
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;

    const href = a.getAttribute("href");
    if (!href) return;

    e.preventDefault();
    location.href = rewriteUrl(href);
  });

  // -------------------------
  // Intercept forms
  // -------------------------
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;

    e.preventDefault();

    const action = form.getAttribute("action") || location.href;
    const method = (form.method || "GET").toUpperCase();
    const formData = new FormData(form);

    if (method === "GET") {
      const params = new URLSearchParams(formData).toString();
      const url = action + (action.includes("?") ? "&" : "?") + params;
      location.href = rewriteUrl(url);
    } else {
      fetch(PROXY_PREFIX + encodeURIComponent(action), {
        method: "POST",
        body: formData,
        credentials: "include"
      }).then(res => res.text())
        .then(html => {
          document.open();
          document.write(html);
          document.close();
        });
    }
  });

  // -------------------------
  // Override fetch
  // -------------------------
  const originalFetch = window.fetch;
  window.fetch = function (url, options = {}) {
    return originalFetch(rewriteUrl(url), {
      ...options,
      credentials: "include"
    });
  };

  // -------------------------
  // Override XMLHttpRequest
  // -------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return origOpen.call(this, method, rewriteUrl(url), ...rest);
  };

  // -------------------------
  // Override window.open
  // -------------------------
  const originalOpen = window.open;
  window.open = function (url, ...args) {
    return originalOpen.call(window, rewriteUrl(url), ...args);
  };

  // -------------------------
  // History API hook
  // -------------------------
  const origPushState = history.pushState;
  history.pushState = function (state, title, url) {
    return origPushState.call(history, state, title, rewriteUrl(url));
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function (state, title, url) {
    return origReplaceState.call(history, state, title, rewriteUrl(url));
  };

  // -------------------------
  // Mutation observer (dynamic content)
  // -------------------------
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          rewriteAttributes(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // -------------------------
  // Initial run
  // -------------------------
  rewriteAttributes();

})();
