const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// Convert a URL to proxied version
function proxify(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

// Resolve relative URLs safely
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

// Universal proxy route
app.all("/proxy", async (req, res) => {
  let target = req.query.url;

  // Generic Wikipedia search support
  if (!target && req.query.search) {
    const language = req.query.language || "en";
    const go = req.query.go || "";
    target = `https://${language}.wikipedia.org/w/index.php?search=${encodeURIComponent(
      req.query.search
    )}&go=${encodeURIComponent(go)}`;
  }

  if (!target) return res.send("No URL provided");
  if (!target.startsWith("http")) target = "https://" + target;

  try {
    const urlObj = new URL(target);

    // Forward GET query parameters (excluding special keys)
    if (req.method === "GET") {
      Object.keys(req.query).forEach((key) => {
        if (!["url", "search", "language", "go"].includes(key)) {
          urlObj.searchParams.set(key, req.query[key]);
        }
      });
    }

    // Fetch page
    const fetchOptions = {
      method: req.method,
      headers: { "User-Agent": "Mozilla/5.0 (OldBrowserProxy)" },
      redirect: "manual",
    };

    if (req.method === "POST") {
      fetchOptions.body = new URLSearchParams(req.body);
      fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    let response = await fetch(urlObj.toString(), fetchOptions);

    // Handle HTTP redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) return res.redirect(proxify(resolveUrl(urlObj, location)));
    }

    let html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Base URL for resolving relative paths
    let baseHref = urlObj.toString();
    const baseTag = document.querySelector("base[href]");
    if (baseTag) {
      baseHref = resolveUrl(urlObj, baseTag.getAttribute("href")) || baseHref;
    }

    // Remove external scripts
    document.querySelectorAll("script[src]").forEach((s) => s.remove());

    // Rewrite CSS links carefully: only relative ones through proxy
    document.querySelectorAll("link[rel='stylesheet']").forEach((el) => {
      const val = el.getAttribute("href");
      if (!val) return;

      if (val.startsWith("http")) {
        // leave absolute CSS as is
      } else if (val.startsWith("//")) {
        el.setAttribute("href", "https:" + val);
      } else {
        const absolute = resolveUrl(baseHref, val);
        if (absolute) el.setAttribute("href", proxify(absolute));
      }
    });

    // Rewrite assets (images, iframes)
    document.querySelectorAll("img, iframe").forEach((el) => {
      const val = el.getAttribute("src");
      if (!val || val.startsWith("data:") || val.startsWith("javascript:")) return;
      const absolute = resolveUrl(baseHref, val);
      if (absolute) el.setAttribute("src", proxify(absolute));
    });

    // Rewrite all links
    document.querySelectorAll("a").forEach((el) => {
      const val = el.getAttribute("href");
      if (!val || val.startsWith("javascript:") || val.startsWith("#")) return;
      const absolute = resolveUrl(baseHref, val);
      if (absolute) el.setAttribute("href", proxify(absolute));
    });

    // Rewrite all forms (keep method + inputs)
    document.querySelectorAll("form").forEach((form) => {
      const action = form.getAttribute("action") || baseHref;
      const absolute = resolveUrl(baseHref, action);
      if (absolute) form.setAttribute("action", proxify(absolute));
      // force GET if old browsers cannot handle POST? Optional
      // form.setAttribute("method", "GET");
    });

    // Convert simple JS navigation (onclick location.href)
    document.querySelectorAll("[onclick]").forEach((el) => {
      const code = el.getAttribute("onclick");
      const match = code.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) {
          el.removeAttribute("onclick");
          el.setAttribute("href", proxify(absolute));
        }
      }
    });

    // Meta refresh redirects
    document.querySelectorAll("meta[http-equiv='refresh']").forEach((meta) => {
      const content = meta.getAttribute("content");
      const match = content.match(/url=(.*)/i);
      if (match) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) meta.setAttribute("content", `0; url=${proxify(absolute)}`);
      }
    });

    res.send(dom.serialize());
  } catch (err) {
    console.error(err);
    res.send("Error loading site");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
