import express from "express";
import fetch from "node-fetch";
import cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// Helper to convert any URL to go through the proxy
function proxify(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

// Helper to resolve relative URLs
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

// Asset proxy (images, CSS, JS, video embeds)
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

    // Merge GET query params
    if (req.method === "GET") {
      Object.keys(req.query).forEach((key) => {
        if (key !== "url") urlObj.searchParams.set(key, req.query[key]);
      });
    }

    const fetchOptions = {
      method: req.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OldBrowserProxy/1.0)",
      },
      redirect: "follow",
    };

    if (req.method === "POST") {
      fetchOptions.body = new URLSearchParams(req.body);
      fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await fetch(urlObj.toString(), fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    // Non-HTML (videos, CSS, JS) streamed directly
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
      const action = resolveUrl(base, $(el).attr("action") || base) || base;
      $(el).attr("action", proxify(action));
      $(el).attr("method", ($(el).attr("method") || "GET").toUpperCase());
    });

    // Proxy assets: images, scripts, iframes (video embeds)
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

    // Keep buttons working (onclick location)
    $("button[onclick]").each((i, el) => {
      const code = $(el).attr("onclick");
      const match = code.match(/(?:location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        const url = resolveUrl(base, match[1]);
        if (url) {
          $(el).removeAttr("onclick");
          $(el).attr("onclick", `window.location='${proxify(url)}'`);
        }
      }
    });

    res.send($.html());
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading site");
  }
});

app.listen(PORT, () => console.log("Old-browser proxy running on port " + PORT));
