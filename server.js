const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Helper: build proxied URL
function proxify(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

// --- Helper: resolve relative URLs
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

// --- Generic asset proxy (images, JS, CSS, etc)
app.get("/asset", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("No URL");

  try {
    const response = await fetch(url);
    res.set("Content-Type", response.headers.get("content-type") || "application/octet-stream");
    response.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Asset error");
  }
});

// --- Main proxy
app.get("/proxy", async (req, res) => {
  let target = req.query.url;

  if (!target) return res.send("No URL provided");

  if (!target.startsWith("http")) {
    target = "https://" + target;
  }

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
      }
    });

    const contentType = response.headers.get("content-type") || "";

    // --- If NOT HTML → just stream it
    if (!contentType.includes("text/html")) {
      res.set("Content-Type", contentType);
      return response.body.pipe(res);
    }

    // --- If HTML → rewrite links
    const html = await response.text();
    const $ = cheerio.load(html);

    const base = target;

    // --- Rewrite ALL links
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

      const absolute = resolveUrl(base, href);
      if (absolute) $(el).attr("href", proxify(absolute));
    });

    // --- Rewrite forms
    $("form").each((i, el) => {
      let action = $(el).attr("action") || base;
      const absolute = resolveUrl(base, action);

      if (absolute) {
        $(el).attr("action", proxify(absolute));
      }
    });

    // --- Rewrite assets
    $("img, script, iframe, link").each((i, el) => {
      let attr = "src";
      if (el.tagName === "link") attr = "href";

      const val = $(el).attr(attr);
      if (!val || val.startsWith("data:")) return;

      const absolute = resolveUrl(base, val);
      if (absolute) {
        $(el).attr(attr, "/asset?url=" + encodeURIComponent(absolute));
      }
    });

    res.send($.html());

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading site");
  }
});

// --- Start server
app.listen(PORT, () => {
  console.log("Proxy running on port " + PORT);
});
