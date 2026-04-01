const express = require("express");
const cheerio = require("cheerio");
const axios = require("axios");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

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
  if (href.startsWith("data:")) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// Image proxy endpoint - fetches images on behalf of the client
// to bypass referer/origin checks
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

    const contentType =
      response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(502).send("Failed to fetch image");
  }
});

app.post("/api/translate", async (req, res) => {
  const { siteUrl } = req.body;

  if (!siteUrl) {
    return res.status(400).json({ error: "URL is required" });
  }

  let page = null;

  try {
    console.log(`[1/4] Launching browser for: ${siteUrl}`);
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate and wait for network to settle
    await page.goto(siteUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Scroll down to trigger lazy-loaded images
    console.log("[2/4] Scrolling to load lazy images...");
    await page.evaluate(async () => {
      const distance = 400;
      const delay = 200;
      const maxScrolls = 30;
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
      // Scroll back to top
      document.scrollingElement.scrollTo(0, 0);
    });

    // Wait a bit for images to finish loading after scroll
    await new Promise((r) => setTimeout(r, 2000));

    // Get the fully rendered HTML
    const renderedHtml = await page.content();
    await page.close();
    page = null;

    console.log("[3/4] Translating text to Nepali...");
    const $ = cheerio.load(renderedHtml);
    const baseUrl = siteUrl;

    // Remove all existing scripts (they won't work out of context anyway)
    $("script").remove();

    // Fix resource URLs to absolute
    $("link[href]").each((_, el) => {
      $(el).attr("href", makeAbsolute($(el).attr("href"), baseUrl));
    });

    // Proxy all images through our server
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const absoluteSrc = makeAbsolute(src, baseUrl);
        if (absoluteSrc && !absoluteSrc.startsWith("data:")) {
          $(el).attr(
            "src",
            `/api/proxy-image?url=${encodeURIComponent(absoluteSrc)}`
          );
        }
      }
      // Handle data-src (lazy load attribute)
      const dataSrc = $(el).attr("data-src");
      if (dataSrc) {
        const absoluteDataSrc = makeAbsolute(dataSrc, baseUrl);
        if (absoluteDataSrc && !absoluteDataSrc.startsWith("data:")) {
          $(el).attr(
            "src",
            `/api/proxy-image?url=${encodeURIComponent(absoluteDataSrc)}`
          );
        }
        $(el).removeAttr("data-src");
      }
      // Handle srcset
      const srcset = $(el).attr("srcset");
      if (srcset) {
        const newSrcset = srcset
          .split(",")
          .map((s) => {
            const parts = s.trim().split(/\s+/);
            const absSrc = makeAbsolute(parts[0], baseUrl);
            parts[0] = `/api/proxy-image?url=${encodeURIComponent(absSrc)}`;
            return parts.join(" ");
          })
          .join(", ");
        $(el).attr("srcset", newSrcset);
      }
      // Remove lazy-load classes that might hide images
      const classes = $(el).attr("class") || "";
      $(el).attr(
        "class",
        classes.replace(/\blazy\b/g, "").replace(/\blazyload\b/g, "")
      );
      // Ensure loading is eager
      $(el).attr("loading", "eager");
    });

    // Handle source elements (picture tags)
    $("source").each((_, el) => {
      const srcset = $(el).attr("srcset");
      if (srcset) {
        const newSrcset = srcset
          .split(",")
          .map((s) => {
            const parts = s.trim().split(/\s+/);
            const absSrc = makeAbsolute(parts[0], baseUrl);
            if (absSrc.startsWith("data:")) return s;
            parts[0] = `/api/proxy-image?url=${encodeURIComponent(absSrc)}`;
            return parts.join(" ");
          })
          .join(", ");
        $(el).attr("srcset", newSrcset);
      }
    });

    // Proxy background images in style attributes
    $("[style]").each((_, el) => {
      let style = $(el).attr("style");
      style = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, p1) => {
        if (p1.startsWith("data:")) return match;
        const abs = makeAbsolute(p1, baseUrl);
        return `url('/api/proxy-image?url=${encodeURIComponent(abs)}')`;
      });
      $(el).attr("style", style);
    });

    // Fix links to absolute
    $("a[href]").each((_, el) => {
      $(el).attr("href", makeAbsolute($(el).attr("href"), baseUrl));
    });

    // Add base tag
    $("head").prepend(`<base href="${baseUrl}">`);

    // Collect text nodes to translate
    const skipTags = new Set([
      "script",
      "style",
      "noscript",
      "code",
      "pre",
      "svg",
      "math",
    ]);
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

    // Translate title
    const title = $("title").text();
    if (title.trim()) {
      $("title").text(await translateText(title));
    }

    // Translate alt attributes
    for (const el of $("img[alt]").toArray()) {
      const alt = $(el).attr("alt");
      if (alt && alt.trim()) {
        $(el).attr("alt", await translateText(alt));
      }
    }

    // Translate placeholder attributes
    for (const el of $("[placeholder]").toArray()) {
      const ph = $(el).attr("placeholder");
      if (ph && ph.trim()) {
        $(el).attr("placeholder", await translateText(ph));
      }
    }

    $("html").attr("lang", "ne");

    console.log("[4/4] Done!");
    res.json({ html: $.html() });
  } catch (err) {
    console.error("Error:", err.message);
    if (page) {
      try { await page.close(); } catch {}
    }
    res
      .status(500)
      .json({ error: `Failed to fetch or translate: ${err.message}` });
  }
});

// Cleanup on exit
process.on("SIGINT", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit();
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
