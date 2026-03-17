import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend JS
app.use(express.static("public"));

// Proxy endpoint
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      },
    });

    let body = await response.text();
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      // Inject client JS into every HTML page
      body = body.replace(
        "</head>",
        `<script src="/proxy-client.js"></script></head>`
      );
    }

    // Remove headers that break proxies
    res.removeHeader("content-security-policy");
    res.removeHeader("x-frame-options");

    res.setHeader("content-type", contentType);
    res.send(body);

  } catch (err) {
    res.status(500).send("Proxy error: " + err.message);
  }
});

// Optional: homepage
app.get("/", (req, res) => {
  res.send(`
    <h2>Web Proxy</h2>
    <form action="/proxy">
      <input name="url" placeholder="https://example.com" style="width:300px"/>
      <button type="submit">Go</button>
    </form>
  `);
});

app.listen(PORT, () => console.log("Running on port " + PORT));
