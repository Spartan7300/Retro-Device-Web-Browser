const express = require("express");
const { pipeline } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// Basic proxy endpoint
app.use("/proxy", async (req, res) => {
  let target = req.query.url;

  if (!target) return res.status(400).send("Missing url");
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

    // Handle redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const absolute = new URL(location, target).toString();
        return res.redirect(`/proxy?url=${encodeURIComponent(absolute)}`);
      }
    }

    // Copy headers
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return; // avoid gzip issues
      res.setHeader(key, value);
    });

    res.status(response.status);

    // Stream response
    pipeline(response.body, res, (err) => {
      if (err) console.error("Pipeline error:", err);
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Proxy error");
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
