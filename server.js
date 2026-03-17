const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/proxy", async (req, res) => {
    let url = req.query.url;

    if (!url) {
        return res.send("No URL provided");
    }

    if (!url.startsWith("http")) {
        url = "https://" + url;
    }

    try {
        const response = await fetch(url);
        let html = await response.text();

        const dom = new JSDOM(html);
        const document = dom.window.document;

        // --- Remove external scripts but keep inline JS ---
        document.querySelectorAll("script").forEach(script => {
            if (script.src) {
                script.remove();
            }
        });

        // --- Rewrite all links to go through proxy ---
        document.querySelectorAll("a").forEach(link => {
            const href = link.getAttribute("href");
            if (href && !href.startsWith("javascript")) {
                link.setAttribute(
                    "href",
                    `/proxy?url=${encodeURIComponent(new URL(href, url))}`
                );
            }
        });

        // --- Rewrite all forms to go through proxy ---
        document.querySelectorAll("form").forEach(form => {
            let action = form.getAttribute("action") || "";
            if (!action.startsWith("javascript")) {
                const absolute = new URL(action, url);
                form.setAttribute("action", "/proxy?url=" + encodeURIComponent(absolute));
                form.setAttribute("method", "GET"); // force GET for old devices
            }
        });

        // --- Rewrite images, CSS, and iframes ---
        document.querySelectorAll("img, link[rel='stylesheet'], iframe").forEach(el => {
            const attr = el.tagName === "LINK" ? "href" : "src";
            const urlAttr = el.getAttribute(attr);
            if (urlAttr && !urlAttr.startsWith("data:") && !urlAttr.startsWith("javascript")) {
                const absolute = new URL(urlAttr, url);
                el.setAttribute(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
            }
        });

        // Optional: remove modern CSS that breaks old browsers (like flex/grid)
        document.querySelectorAll("style, link[rel='stylesheet']").forEach(el => {
            // could process stylesheets here if desired for old-device simplification
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
