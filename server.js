const express = require("express");
const cheerio = require("cheerio");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Store translated pages in memory (auto-cleanup after 30 min)
const translatedPages = new Map();

function storePage(html) {
  const id = crypto.randomBytes(8).toString("hex");
  translatedPages.set(id, html);
  setTimeout(() => translatedPages.delete(id), 30 * 60 * 1000);
  return id;
}

// Serve translated page directly (not as blob)
app.get("/view/:id", (req, res) => {
  const html = translatedPages.get(req.params.id);
  if (!html) return res.status(404).send("Page expired or not found");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Reusable browser instance
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-web-security",
        "--disable-dev-shm-usage",
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browserInstance = await puppeteer.launch(launchOptions);
  }
  return browserInstance;
}

// Google Translate (free endpoint)
async function translateText(text, targetLang = "ne") {
  if (!text || !text.trim()) return text;

  const encoded = encodeURIComponent(text);
  const apiUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encoded}`;

  try {
    const res = await axios.get(apiUrl, { timeout: 10000 });
    const translated = res.data[0].map((s) => s[0]).join("");
    return translated;
  } catch {
    return text;
  }
}

// Batch translate with concurrency control
async function batchTranslate(texts, targetLang = "ne") {
  const BATCH_SIZE = 30;
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const promises = batch.map((t, idx) =>
      translateText(t, targetLang).then((translated) => {
        results[i + idx] = translated;
      })
    );
    await Promise.all(promises);
  }

  return results;
}

// Make relative URLs absolute
function makeAbsolute(href, baseUrl) {
  if (!href) return href;
  if (href.startsWith("data:") || href.startsWith("javascript:") || href.startsWith("#")) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// Image proxy endpoint
app.get("/api/proxy-image", async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send("Missing url param");

  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: new URL(imageUrl).origin + "/",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      maxRedirects: 5,
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(502).send("Failed to fetch image");
  }
});

// General resource proxy (for CSS, JS, etc.)
app.get("/api/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing url param");

  try {
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: new URL(targetUrl).origin + "/",
      },
      maxRedirects: 5,
    });

    const contentType = response.headers["content-type"] || "application/octet-stream";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(502).send("Failed to fetch resource");
  }
});

app.post("/api/translate", async (req, res) => {
  const { siteUrl } = req.body;

  if (!siteUrl) {
    return res.status(400).json({ error: "URL is required" });
  }

  let page = null;
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const serverOrigin = `${proto}://${req.get("host")}`;

  try {
    console.log(`[1/4] Launching browser for: ${siteUrl}`);
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.goto(siteUrl, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await new Promise((r) => setTimeout(r, 3000));

    // Scroll to trigger lazy-loaded images
    console.log("[2/4] Scrolling to load lazy images...");
    await page.evaluate(async () => {
      const distance = 600;
      const delay = 150;
      const maxScrolls = 15;
      let scrolls = 0;

      while (
        scrolls < maxScrolls &&
        document.scrollingElement.scrollTop + window.innerHeight <
          document.scrollingElement.scrollHeight
      ) {
        document.scrollingElement.scrollBy(0, distance);
        await new Promise((r) => setTimeout(r, delay));
        scrolls++;
      }
      document.scrollingElement.scrollTo(0, 0);
    });

    await new Promise((r) => setTimeout(r, 1500));

    const renderedHtml = await page.content();
    await page.close();
    page = null;

    console.log("[3/4] Translating text to Nepali...");
    const $ = cheerio.load(renderedHtml);
    const baseUrl = siteUrl;

    // Proxy external scripts (keep them working)
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const absSrc = makeAbsolute(src, baseUrl);
        if (absSrc && !absSrc.startsWith("data:")) {
          $(el).attr("src", `${serverOrigin}/api/proxy?url=${encodeURIComponent(absSrc)}`);
        }
      }
    });

    // Proxy CSS links
    $("link[rel='stylesheet'][href], link[type='text/css'][href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const absHref = makeAbsolute(href, baseUrl);
        if (absHref && !absHref.startsWith("data:")) {
          $(el).attr("href", `${serverOrigin}/api/proxy?url=${encodeURIComponent(absHref)}`);
        }
      }
    });

    // Other link tags (favicon etc.) - make absolute
    $("link:not([rel='stylesheet']):not([type='text/css'])").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        $(el).attr("href", makeAbsolute(href, baseUrl));
      }
    });

    // Proxy all images
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const absoluteSrc = makeAbsolute(src, baseUrl);
        if (absoluteSrc && !absoluteSrc.startsWith("data:")) {
          $(el).attr("src", `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absoluteSrc)}`);
        }
      }
      const dataSrc = $(el).attr("data-src");
      if (dataSrc) {
        const absoluteDataSrc = makeAbsolute(dataSrc, baseUrl);
        if (absoluteDataSrc && !absoluteDataSrc.startsWith("data:")) {
          $(el).attr("src", `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absoluteDataSrc)}`);
          $(el).attr("data-src", `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absoluteDataSrc)}`);
        }
      }
      const srcset = $(el).attr("srcset");
      if (srcset) {
        const newSrcset = srcset.split(",").map((s) => {
          const parts = s.trim().split(/\s+/);
          const absSrc = makeAbsolute(parts[0], baseUrl);
          parts[0] = `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absSrc)}`;
          return parts.join(" ");
        }).join(", ");
        $(el).attr("srcset", newSrcset);
      }
      const classes = $(el).attr("class") || "";
      $(el).attr("class", classes.replace(/\blazy\b/g, "").replace(/\blazyload\b/g, ""));
      $(el).attr("loading", "eager");
    });

    // Handle source elements (picture tags)
    $("source").each((_, el) => {
      const srcset = $(el).attr("srcset");
      if (srcset) {
        const newSrcset = srcset.split(",").map((s) => {
          const parts = s.trim().split(/\s+/);
          const absSrc = makeAbsolute(parts[0], baseUrl);
          if (absSrc.startsWith("data:")) return s;
          parts[0] = `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absSrc)}`;
          return parts.join(" ");
        }).join(", ");
        $(el).attr("srcset", newSrcset);
      }
    });

    // Proxy background images in style attributes
    $("[style]").each((_, el) => {
      let style = $(el).attr("style");
      style = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
        if (p1.startsWith("data:")) return match;
        const abs = makeAbsolute(p1, baseUrl);
        return `url('${serverOrigin}/api/proxy-image?url=${encodeURIComponent(abs)}')`;
      });
      $(el).attr("style", style);
    });

    // Fix links to absolute
    $("a[href]").each((_, el) => {
      $(el).attr("href", makeAbsolute($(el).attr("href"), baseUrl));
    });

    // Add base tag for any remaining relative URLs
    $("head").prepend(`<base href="${baseUrl}">`);

    // Collect text nodes to translate (skip script/style)
    const skipTags = new Set(["script", "style", "noscript", "code", "pre", "svg", "math"]);
    const textNodes = [];

    function walkNodes(nodes) {
      nodes.each((_, node) => {
        if (node.type === "text") {
          const parent = node.parent;
          if (parent && skipTags.has(parent.name)) return;
          const text = $(node).text();
          if (text.trim().length > 0) {
            textNodes.push(node);
          }
        } else if (node.type === "tag") {
          walkNodes($(node).contents());
        }
      });
    }

    walkNodes($.root().contents());

    const textsToTranslate = textNodes.map((n) => $(n).text());
    console.log(`   Translating ${textsToTranslate.length} text nodes...`);

    const translated = await batchTranslate(textsToTranslate);

    textNodes.forEach((node, i) => {
      if (translated[i]) {
        $(node).replaceWith(translated[i]);
      }
    });

    const title = $("title").text();
    if (title.trim()) {
      $("title").text(await translateText(title));
    }

    for (const el of $("img[alt]").toArray()) {
      const alt = $(el).attr("alt");
      if (alt && alt.trim()) {
        $(el).attr("alt", await translateText(alt));
      }
    }

    for (const el of $("[placeholder]").toArray()) {
      const ph = $(el).attr("placeholder");
      if (ph && ph.trim()) {
        $(el).attr("placeholder", await translateText(ph));
      }
    }

    $("html").attr("lang", "ne");

    // Store translated HTML and return view URL
    const pageId = storePage($.html());
    const viewUrl = `${serverOrigin}/view/${pageId}`;

    console.log("[4/4] Done!");
    res.json({ viewUrl });
  } catch (err) {
    console.error("Error:", err.message);
    if (page) {
      try { await page.close(); } catch {}
    }
    res.status(500).json({ error: `Failed to fetch or translate: ${err.message}` });
  }
});

process.on("SIGINT", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
