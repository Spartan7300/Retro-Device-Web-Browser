const express = require("express");
const { pipeline } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// universal proxy handler
async function handleProxy(req, res) {
  let target = req.query.url;

  // if no direct URL, but a search query exists, send to DuckDuckGo
  if (!target && req.query.q) {
    target = `https://duckduckgo.com/?q=${encodeURIComponent(req.query.q)}`;
  }

  // if still nothing, send default to DuckDuckGo blank search
  if (!target) {
    target = "https://duckduckgo.com/";
  }

  // ensure proper schema
  if (!/^https?:\/\//i.test(target)) {
    target = "https://" + target;
  }

  try {
    const response = await fetch(target, {
      method: req.method,
      headers: {
        ...req.headers,
        host: new URL(target).host,
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      redirect: "manual",
    });

    // handle redirects through the proxy
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const absolute = new URL(location, target).toString();
        return res.redirect(`/proxy?url=${encodeURIComponent(absolute)}`);
      }
    }

    // forward headers
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return;
      res.setHeader(key, value);
    });

    res.status(response.status);
    pipeline(response.body, res, (err) => {
      if (err) console.error("pipeline error:", err);
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy fetch error");
  }
}

// bind proxy route
app.use("/proxy", handleProxy);

// send everything else through proxy handler
app.use((req, res) => handleProxy(req, res));

// start
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
