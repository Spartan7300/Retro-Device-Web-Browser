const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/proxy", async (req, res) => {
    let target = req.query.url;

    // --- Wikipedia special handling ---
    if (!target && req.query.family === "wikipedia") {
        const search = req.query.search || "";
        const language = req.query.language || "en";
        const go = req.query.go || "";
        target = `https://${language}.wikipedia.org/w/index.php?search=${encodeURIComponent(search)}&go=${encodeURIComponent(go)}`;
    }

    // --- Google search handling (NEW) ---
    if (!target && req.query.q) {
        const query = encodeURIComponent(req.query.q);
        target = `https://www.google.com/search?q=${query}`;
    }

    if (!target) {
        return res.send("No URL provided");
    }

    if (!target.startsWith("http")) {
        target = "https://" + target;
    }

    try {
        const urlObj = new URL(target);

        // --- Forward query params (excluding special ones) ---
        Object.keys(req.query).forEach(key => {
            if (!["url", "family", "search", "language", "go", "q"].includes(key)) {
                urlObj.searchParams.set(key, req.query[key]);
            }
        });

        const response = await fetch(urlObj.toString(), {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; OldBrowserProxy/1.0)"
            }
        });

        let html = await response.text();

        const dom = new JSDOM(html);
        const document = dom.window.document;

        // --- Remove external scripts ---
        document.querySelectorAll("script").forEach(script => {
            if (script.src) script.remove();
        });

        // --- Rewrite links ---
        document.querySelectorAll("a").forEach(link => {
            const href = link.getAttribute("href");
            if (href && !href.startsWith("javascript")) {
                try {
                    const absolute = new URL(href, urlObj);
                    link.setAttribute(
                        "href",
                        `/proxy?url=${encodeURIComponent(absolute)}`
                    );
                } catch {}
            }
        });

        // --- Rewrite forms ---
        document.querySelectorAll("form").forEach(form => {
            let action = form.getAttribute("action") || "";

            if (!action.startsWith("javascript")) {
                try {
                    const absolute = new URL(action, urlObj);

                    // Detect Google search form
                    const searchInput = form.querySelector("input[name='q']");

                    if (absolute.hostname.includes("google.com") && searchInput) {
                        // Force simple GET-based search
                        form.setAttribute("method", "GET");
                        form.setAttribute("action", "/proxy");

                        // Remove all other inputs except 'q'
                        form.querySelectorAll("input").forEach(input => {
                            if (input.name !== "q") input.remove();
                        });

                    } else {
                        // Default rewrite
                        form.setAttribute("method", "GET");
                        form.setAttribute(
                            "action",
                            "/proxy?url=" + encodeURIComponent(absolute)
                        );
                    }

                } catch {}
            }
        });

        // --- Rewrite assets ---
        document.querySelectorAll("img, link[rel='stylesheet'], iframe").forEach(el => {
            const attr = el.tagName === "LINK" ? "href" : "src";
            const val = el.getAttribute(attr);

            if (val && !val.startsWith("data:") && !val.startsWith("javascript")) {
                try {
                    const absolute = new URL(val, urlObj);
                    el.setAttribute(
                        attr,
                        `/proxy?url=${encodeURIComponent(absolute)}`
                    );
                } catch {}
            }
        });

        res.send(document.documentElement.outerHTML);

    } catch (err) {
        console.error(err);
        res.send("Error loading site");
    }
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
