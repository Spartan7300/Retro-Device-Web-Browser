const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

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

app.all("/proxy", async (req, res) => {
  let target = req.query.url;

  // --- Generic Wikipedia search support ---
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
        if (key !== "url" && key !== "search" && key !== "language" && key !== "go") {
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

    let html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;

    let baseHref = urlObj.toString();
    const baseTag = document.querySelector("base[href]");
    if (baseTag) {
      baseHref = resolveUrl(urlObj, baseTag.getAttribute("href")) || baseHref;
    }

    document.querySelectorAll("script[src]").forEach((s) => s.remove());

    const urlAttrs = ["href", "src", "action"];
    document.querySelectorAll("*").forEach((el) => {
      urlAttrs.forEach((attr) => {
        const val = el.getAttribute(attr);
        if (!val) return;
        if (val.startsWith("data:") || val.startsWith("javascript:") || val.startsWith("#"))
          return;
        const absolute = resolveUrl(baseHref, val);
        if (absolute) el.setAttribute(attr, proxify(absolute));
      });
    });

    document.querySelectorAll("form").forEach((form) => {
      let action = form.getAttribute("action") || baseHref;
      const absolute = resolveUrl(baseHref, action);
      if (absolute) form.setAttribute("action", proxify(absolute));
    });

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
