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

// Asset proxy
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
    const urlObj = new URL(target);

    if (req.method === "GET") {
      Object.keys(req.query).forEach((key) => {
        if (key !== "url") {
          urlObj.searchParams.set(key, req.query[key]);
        }
      });
    }

    const fetchOptions = {
      method: req.method,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
      redirect: "follow",
    };

    if (req.method === "POST") {
      fetchOptions.body = new URLSearchParams(req.body);
      fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await fetch(urlObj.toString(), fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      res.set("Content-Type", contentType);
      return response.body.pipe(res);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const base = urlObj.toString();

    // Rewrite links
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      const absolute = resolveUrl(base, href);
      if (absolute) $(el).attr("href", proxify(absolute));
    });

    // Rewrite forms
    $("form").each((i, el) => {
      let action = $(el).attr("action") || base;
      const absolute = resolveUrl(base, action) || base;

      $(el).attr("action", proxify(absolute));
      const method = ($(el).attr("method") || "GET").toUpperCase();
      $(el).attr("method", method);
    });

    // Rewrite assets
    $("img, iframe, script").each((i, el) => {
      const src = $(el).attr("src");
      if (!src || src.startsWith("data:")) return;

      const absolute = resolveUrl(base, src);
      if (absolute) $(el).attr("src", "/asset?url=" + encodeURIComponent(absolute));
    });

    $("link").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;

      const absolute = resolveUrl(base, href);
      if (absolute) $(el).attr("href", "/asset?url=" + encodeURIComponent(absolute));
    });

    // --- NEW: Convert buttons that use location.href into <a> links ---
    $("button[onclick]").each((i, el) => {
      const code = $(el).attr("onclick");
      // Match simple location.href = 'URL' patterns
      const match = code.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        const url = resolveUrl(base, match[1]);
        if (url) {
          const innerHtml = $(el).html();
          // Replace button with styled link
          $(el).replaceWith(`<a href="${proxify(url)}" style="display:inline-block">${innerHtml}</a>`);
        }
      }
    });

    res.send($.html());
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading site");
  }
});

app.listen(PORT, () => {
  console.log("Proxy running on port " + PORT);
});
