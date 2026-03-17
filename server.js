const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");
const cookieParser = require("cookie-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/**
 * Convert any URL to proxied version
 */
function proxify(url) {
    return "/proxy?url=" + encodeURIComponent(url);
}

/**
 * Resolve URL safely
 */
function resolveUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch {
        return null;
    }
}

app.all("/proxy", async (req, res) => {
    let target = req.query.url;

    if (!target) {
        return res.send("No URL provided");
    }

    if (!target.startsWith("http")) {
        target = "https://" + target;
    }

    try {
        const urlObj = new URL(target);

        // --- Forward query params (GET) ---
        if (req.method === "GET") {
            Object.keys(req.query).forEach(key => {
                if (key !== "url") {
                    urlObj.searchParams.set(key, req.query[key]);
                }
            });
        }

        // --- Forward cookies ---
        const cookieHeader = req.headers.cookie || "";

        const fetchOptions = {
            method: req.method,
            headers: {
                "User-Agent": "Mozilla/5.0 (OldBrowserProxy)",
                "Cookie": cookieHeader
            },
            redirect: "manual"
        };

        // --- Handle POST body ---
        if (req.method === "POST") {
            fetchOptions.body = new URLSearchParams(req.body);
            fetchOptions.headers["Content-Type"] = "application/x-www-form-urlencoded";
        }

        let response = await fetch(urlObj.toString(), fetchOptions);

        // --- Handle HTTP redirects ---
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (location) {
                const redirectUrl = resolveUrl(urlObj, location);
                return res.redirect(proxify(redirectUrl));
            }
        }

        // --- Pass cookies back ---
        const setCookie = response.headers.raw()["set-cookie"];
        if (setCookie) {
            res.setHeader("set-cookie", setCookie);
        }

        let html = await response.text();

        const dom = new JSDOM(html);
        const document = dom.window.document;

        // --- Handle <base> tag ---
        let baseHref = urlObj.toString();
        const baseTag = document.querySelector("base[href]");
        if (baseTag) {
            baseHref = resolveUrl(urlObj, baseTag.getAttribute("href")) || baseHref;
        }

        // --- Remove external scripts (but keep inline) ---
        document.querySelectorAll("script[src]").forEach(s => s.remove());

        // --- Rewrite ALL URL attributes ---
        const urlAttrs = ["href", "src", "action"];

        document.querySelectorAll("*").forEach(el => {
            urlAttrs.forEach(attr => {
                const val = el.getAttribute(attr);
                if (!val) return;

                if (
                    val.startsWith("data:") ||
                    val.startsWith("javascript:") ||
                    val.startsWith("#")
                ) return;

                const absolute = resolveUrl(baseHref, val);
                if (absolute) {
                    el.setAttribute(attr, proxify(absolute));
                }
            });
        });

        // --- Fix forms (preserve method + inputs) ---
        document.querySelectorAll("form").forEach(form => {
            let action = form.getAttribute("action") || baseHref;
            const absolute = resolveUrl(baseHref, action);

            if (absolute) {
                form.setAttribute("action", proxify(absolute));
            }

            // DO NOT force GET anymore
        });

        // --- Convert JS navigation (onclick etc.) ---
        document.querySelectorAll("[onclick]").forEach(el => {
            const code = el.getAttribute("onclick");

            // naive detection of location changes
            const match = code.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);

            if (match) {
                const absolute = resolveUrl(baseHref, match[1]);
                if (absolute) {
                    el.removeAttribute("onclick");
                    el.setAttribute("href", proxify(absolute));
                }
            }
        });

        // --- Handle meta refresh redirects ---
        document.querySelectorAll("meta[http-equiv='refresh']").forEach(meta => {
            const content = meta.getAttribute("content");
            const match = content.match(/url=(.*)/i);
            if (match) {
                const absolute = resolveUrl(baseHref, match[1]);
                if (absolute) {
                    meta.setAttribute("content", `0; url=${proxify(absolute)}`);
                }
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
