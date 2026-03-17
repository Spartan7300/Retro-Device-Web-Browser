const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = 3000;

app.use(express.static("public"));

app.get("/proxy", async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.send("No URL provided");
    }

    try {
        const response = await fetch(url);
        let html = await response.text();

        html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");

        res.send(html);
    } catch (err) {
        res.send("Error fetching site");
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
