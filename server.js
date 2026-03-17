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

        // Remove scripts that break old browsers
        document.querySelectorAll("script").forEach(el => el.remove());

        // Rewrite all links to go through proxy
        document.querySelectorAll("a").forEach(link => {
            const href = link.getAttribute("href");
            if (href && !href.startsWith("javascript")) {
                link.setAttribute(
                    "href",
                    `/proxy?url=${encodeURIComponent(new URL(href, url))}`
                );
            }
        });

        // Rewrite all forms to go through proxy
        document.querySelectorAll("form").forEach(form => {
            let action = form.getAttribute("action") || "";
            if (!action.startsWith("javascript")) {
                const absolute = new URL(action, url);
                form.setAttribute("action", "/proxy?url=" + encodeURIComponent(absolute));
                form.setAttribute("method", "GET"); // force GET to simplify old browsers
            }
        });

        res.send(document.documentElement.outerHTML);

    } catch (err) {
        res.send("Error loading site");
    }
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
