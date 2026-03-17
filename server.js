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

        document.querySelectorAll("script").forEach(el => el.remove());

        document.querySelectorAll("a").forEach(link => {
            const href = link.getAttribute("href");
            if (href && !href.startsWith("javascript")) {
                link.setAttribute("href", `/proxy?url=${encodeURIComponent(new URL(href, url))}`);
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
