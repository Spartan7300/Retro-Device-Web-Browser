const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse POST forms
app.use(express.urlencoded({ extended: true }));

// Helper to rewrite URLs through the proxy
function proxify(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

// Resolve relative URLs
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

// Asset proxy for images, CSS, JS, iframes
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

// Main proxy
app.all("/proxy", async (req, res) => {
  let target = req.query.url;
  if (!target) return res.send("No URL provided");
  if (!target.startsWith("http")) target = "https://" + target;

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      redirect: "manual",
    };

    if (req.method === "POST") {
      fetchOptions.body = new URLSearchParams(req.body);
      fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await fetch(target, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    // Stream non-HTML directly
    if (!contentType.includes("text/html")) {
      res.set("Content-Type", contentType);
      return response.body.pipe(res);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const base = target;

    // --- Rewrite all links ---
    $("a").each((i, el) => {
      let href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      const absolute = resolveUrl(base, href);
      if (absolute) $(el).attr("href", proxify(absolute));
    });

    // --- Rewrite all forms ---
    $("form").each((i, el) => {
      let action = $(el).attr("action") || base;
      const absolute = resolveUrl(base, action) || base;

      $(el).attr("action", proxify(absolute));

      // Preserve GET/POST method
      const method = ($(el).attr("method") || "GET").toUpperCase();
      $(el).attr("method", method);
    });

    // --- Rewrite all assets ---
    $("img, iframe, script, link").each((i, el) => {
      let attr = el.tagName === "LINK" ? "href" : "src";
      const val = $(el).attr(attr);
      if (!val || val.startsWith("data:")) return;

      const absolute = resolveUrl(base, val);
      if (absolute) $(el).attr(attr, "/asset?url=" + encodeURIComponent(absolute));
    });

    res.send($.html());
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading site");
  }
});

// Start server
app.listen(PORT, () => {
  console.log("Proxy running on port " + PORT);
});
