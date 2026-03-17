const express = require("express");
const fetch = require("node-fetch");
const { JSDOM } = require("jsdom");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/proxy", async (req, res) => {
    let target = req.query.url;

    if (!target) {
        return res.send("No URL provided");
    }

    if (!target.startsWith("http")) {
        target = "https://" + target;
    }

    try {
        const urlObj = new URL(target);

        // Forward all additional query parameters (e.g., ?q=search)
        Object.keys(req.query).forEach(key => {
            if (key !== "url") {
                urlObj.searchParams.append(key, req.query[key]);
            }
        });

        const response = await fetch(urlObj.toString());
        let html = await response.text();

        const dom = new JSDOM(html);
        const document = dom.window.document;

        // --- Remove external scripts (keep inline scripts for layout) ---
        document.querySelectorAll("script").forEach(script => {
            if (script.src) script.remove();
        });

        // --- Rewrite all links ---
        document.querySelectorAll("a").forEach(link => {
            const href = link.getAttribute("href");
            if (href && !href.startsWith("javascript")) {
                link.setAttribute(
                    "href",
                    `/proxy?url=${encodeURIComponent(new URL(href, urlObj))}`
                );
            }
        });

        // --- Rewrite all forms to go through proxy ---
        document.querySelectorAll("form").forEach(form => {
            let action = form.getAttribute("action") || "";
            if (!action.startsWith("javascript")) {
                const absolute = new URL(action, urlObj);
                form.setAttribute("method", "GET"); // force GET for old devices
                form.setAttribute(
                    "action",
                    "/proxy?url=" + encodeURIComponent(absolute)
                );
            }
        });

        // --- Rewrite assets: images, CSS, iframes ---
        document.querySelectorAll("img, link[rel='stylesheet'], iframe").forEach(el => {
            const attr = el.tagName === "LINK" ? "href" : "src";
            const val = el.getAttribute(attr);
            if (val && !val.startsWith("data:") && !val.startsWith("javascript")) {
                const absolute = new URL(val, urlObj);
                el.setAttribute(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
            }
        });

        // Optional: further CSS simplification for very old browsers could go here

        res.send(document.documentElement.outerHTML);

    } catch (err) {
        console.error(err);
        res.send("Error loading site");
    }
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
