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

// --- Serve CSS with rewritten URLs ---
app.get("/proxy-css", async (req, res) => {
  const cssUrl = req.query.url;
  if (!cssUrl) return res.send("");

  try {
    const response = await fetch(cssUrl);
    let css = await response.text();

    // Rewrite relative URLs in CSS
    css = css.replace(/url\(([^)]+)\)/g, (match, path) => {
      path = path.replace(/['"]/g, "");
      const absolute = resolveUrl(cssUrl, path);
      return `url(${proxify(absolute)})`;
    });

    res.set("Content-Type", "text/css");
    res.send(css);
  } catch (e) {
    console.error(e);
    res.send("");
  }
});

// --- Universal proxy ---
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

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) return res.redirect(proxify(resolveUrl(urlObj, location)));
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let baseHref = urlObj.toString();
    const baseTag = $("base[href]").attr("href");
    if (baseTag) baseHref = resolveUrl(urlObj, baseTag) || baseHref;

    // Remove external scripts
    $("script[src]").remove();

    // Rewrite CSS links through /proxy-css
    $("link[rel='stylesheet']").each((i, el) => {
      let href = $(el).attr("href");
      if (!href) return;
      if (href.startsWith("http")) {
        $(el).attr("href", `/proxy-css?url=${encodeURIComponent(href)}`);
      } else if (href.startsWith("//")) {
        $(el).attr("href", `/proxy-css?url=${encodeURIComponent("https:" + href)}`);
      } else {
        const absolute = resolveUrl(baseHref, href);
        if (absolute) $(el).attr("href", `/proxy-css?url=${encodeURIComponent(absolute)}`);
      }
    });

    // Rewrite images & iframes
    $("img, iframe").each((i, el) => {
      let src = $(el).attr("src");
      if (!src || src.startsWith("data:") || src.startsWith("javascript:")) return;
      const absolute = resolveUrl(baseHref, src);
      if (absolute) $(el).attr("src", proxify(absolute));
    });

    // Rewrite links
    $("a").each((i, el) => {
      let href = $(el).attr("href");
      if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
      const absolute = resolveUrl(baseHref, href);
      if (absolute) $(el).attr("href", proxify(absolute));
    });

    // Rewrite forms
    $("form").each((i, form) => {
      let action = $(form).attr("action") || baseHref;
      const absolute = resolveUrl(baseHref, action);
      if (absolute) $(form).attr("action", proxify(absolute));
    });

    // Convert buttons with location.href / window.location to links
    $("[onclick]").each((i, el) => {
      const code = $(el).attr("onclick");
      const match = code.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) {
          // Keep the original element in UI
          const elHtml = $.html(el);
          $(el).replaceWith(`<a href="${proxify(absolute)}" style="display:inline-block">${elHtml}</a>`);
        }
      }
    });

    // Meta refresh redirects
    $("meta[http-equiv='refresh']").each((i, meta) => {
      const content = $(meta).attr("content");
      const match = content.match(/url=(.*)/i);
      if (match) {
        const absolute = resolveUrl(baseHref, match[1]);
        if (absolute) $(meta).attr("content", `0; url=${proxify(absolute)}`);
      }
    });

    res.send($.html());
  } catch (err) {
    console.error(err);
    res.send("Error loading site");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
