const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

function proxify(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

// Serve CSS, rewriting only relative URLs
app.get("/proxy-css", async (req, res) => {
  const cssUrl = req.query.url;
  if (!cssUrl) return res.send("");

  try {
    const response = await fetch(cssUrl);
    let css = await response.text();

    // Only rewrite relative URLs
    css = css.replace(/url\(([^)]+)\)/g, (match, path) => {
      path = path.replace(/['"]/g, "").trim();
      const absolute = resolveUrl(cssUrl, path);
      return absolute ? `url(${proxify(absolute)})` : match;
    });

    res.set("Content-Type", "text/css");
    res.send(css);
  } catch (e) {
    console.error(e);
    res.send("");
  }
});

// Universal proxy — negative/patch-only approach
app.all("/proxy", async (req, res) => {
  let target = req.query.url;

  // Wikipedia search support
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

    if (req.method === "GET") {
      Object.keys(req.query).forEach((key) => {
        if (!["url", "search", "language", "go"].includes(key)) {
          urlObj.searchParams.set(key, req.query[key]);
        }
      });
    }

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

    // Handle redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) return res.redirect(proxify(resolveUrl(urlObj, location)));
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let baseHref = urlObj.toString();
    const baseTag = $("base[href]").attr("href");
    if (baseTag) baseHref = resolveUrl(urlObj, baseTag) || baseHref;

    // --- Patch-only rewrites ---

    // 1. CSS links — rewrite only if relative/protocol-relative
    $("link[rel='stylesheet']").each((i, el) => {
      let href = $(el).attr("href");
      if (!href) return;
      if (!href.startsWith("http")) {
        const absolute = resolveUrl(baseHref, href.startsWith("//") ? "https:" + href : href);
        if (absolute) $(el).attr("href", `/proxy-css?url=${encodeURIComponent(absolute)}`);
      }
    });

    // 2. Images & iframes — rewrite only relative URLs
    $("img, iframe").each((i, el) => {
      let src = $(el).attr("src");
      if (!src || src.startsWith("data:") || src.startsWith("http") || src.startsWith("javascript:")) return;
      const absolute = resolveUrl(baseHref, src);
      if (absolute) $(el).attr("src", proxify(absolute));
    });

    // 3. Forms — only rewrite relative actions
    $("form").each((i, form) => {
      let action = $(form).attr("action") || baseHref;
      if (!action.startsWith("http")) {
        const absolute = resolveUrl(baseHref, action);
        if (absolute) $(form).attr("action", proxify(absolute));
      }
    });

    // 4. Links — only rewrite relative hrefs
    $("a").each((i, el) => {
      let href = $(el).attr("href");
      if (!href || href.startsWith("http") || href.startsWith("javascript:") || href.startsWith("#")) return;
      const absolute = resolveUrl(baseHref, href);
      if (absolute) $(el).attr("href", proxify(absolute));
    });

    // 5. Buttons with location.href — patch only those
    $("[onclick]").each((i, el) => {
      const code = $(el).attr("onclick");
      const match = code.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) {
          const elHtml = $.html(el);
          $(el).replaceWith(`<a href="${proxify(absolute)}" style="display:inline-block">${elHtml}</a>`);
        }
      }
    });

    // 6. Meta refresh — patch only relative URLs
    $("meta[http-equiv='refresh']").each((i, meta) => {
      const content = $(meta).attr("content");
      const match = content.match(/url=(.*)/i);
      if (match && !match[1].startsWith("http")) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) $(meta).attr("content", `0; url=${proxify(absolute)}`);
      }
    });

    // **Important:** We keep all other scripts, CSS, and layout intact by default

    res.send($.html());
  } catch (err) {
    console.error(err);
    res.send("Error loading site");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
