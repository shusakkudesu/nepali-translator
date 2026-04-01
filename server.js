const express = require("express");
const cheerio = require("cheerio");
const axios = require("axios");
const path = require("path");
const crypto = require("crypto");

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

// Serve translated page directly
app.get("/view/:id", (req, res) => {
  const html = translatedPages.get(req.params.id);
  if (!html) return res.status(404).send("Page expired or not found");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

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

// Batch translate
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
  if (href.startsWith("data:") || href.startsWith("javascript:") || href.startsWith("#") || href.startsWith("blob:")) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// Image proxy
app.get("/api/proxy-image", async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send("Missing url param");

  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: new URL(imageUrl).origin + "/",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      maxRedirects: 5,
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch {
    res.status(502).send("Failed to fetch image");
  }
});

// General resource proxy (CSS, JS, etc.)
app.get("/api/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing url param");

  try {
    const response = await axios.get(targetUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: new URL(targetUrl).origin + "/",
      },
      maxRedirects: 5,
    });

    const contentType = response.headers["content-type"] || "application/octet-stream";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(Buffer.from(response.data));
  } catch {
    res.status(502).send("Failed to fetch resource");
  }
});

app.post("/api/translate", async (req, res) => {
  const { siteUrl } = req.body;

  if (!siteUrl) {
    return res.status(400).json({ error: "URL is required" });
  }

  const proto = req.get("x-forwarded-proto") || req.protocol;
  const serverOrigin = `${proto}://${req.get("host")}`;

  try {
    console.log(`[1/3] Fetching: ${siteUrl}`);
    const siteOrigin = new URL(siteUrl).origin;
    const response = await axios.get(siteUrl, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: siteOrigin + "/",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      maxRedirects: 5,
      decompress: true,
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const baseUrl = siteUrl;

    console.log("[2/3] Rewriting URLs and translating...");

    // Proxy external scripts
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src) {
        const absSrc = makeAbsolute(src, baseUrl);
        if (absSrc && !absSrc.startsWith("data:")) {
          $(el).attr("src", `${serverOrigin}/api/proxy?url=${encodeURIComponent(absSrc)}`);
        }
      }
    });

    // Proxy CSS
    $("link[rel='stylesheet'][href], link[type='text/css'][href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        const absHref = makeAbsolute(href, baseUrl);
        if (absHref && !absHref.startsWith("data:")) {
          $(el).attr("href", `${serverOrigin}/api/proxy?url=${encodeURIComponent(absHref)}`);
        }
      }
    });

    // Other link tags - make absolute
    $("link:not([rel='stylesheet']):not([type='text/css'])").each((_, el) => {
      const href = $(el).attr("href");
      if (href) {
        $(el).attr("href", makeAbsolute(href, baseUrl));
      }
    });

    // Proxy images + handle lazy load attributes
    $("img").each((_, el) => {
      // Handle all possible image source attributes
      const imgAttrs = ["src", "data-src", "data-original", "data-lazy-src", "data-echo"];
      let bestSrc = null;

      for (const attr of imgAttrs) {
        const val = $(el).attr(attr);
        if (val && !val.startsWith("data:")) {
          const absVal = makeAbsolute(val, baseUrl);
          const proxied = `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absVal)}`;
          $(el).attr(attr, proxied);
          if (!bestSrc) bestSrc = proxied;
        }
      }

      // Always set src if we found a source
      if (bestSrc && !$(el).attr("src")) {
        $(el).attr("src", bestSrc);
      }

      // Handle srcset
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

      // Also handle data-srcset
      const dataSrcset = $(el).attr("data-srcset");
      if (dataSrcset) {
        const newSrcset = dataSrcset.split(",").map((s) => {
          const parts = s.trim().split(/\s+/);
          const absSrc = makeAbsolute(parts[0], baseUrl);
          if (absSrc.startsWith("data:")) return s;
          parts[0] = `${serverOrigin}/api/proxy-image?url=${encodeURIComponent(absSrc)}`;
          return parts.join(" ");
        }).join(", ");
        $(el).attr("data-srcset", newSrcset);
      }

      $(el).attr("loading", "eager");
    });

    // Handle source elements
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

    // Add base tag
    $("head").prepend(`<base href="${baseUrl}">`);

    // Collect text nodes to translate
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

    const pageId = storePage($.html());
    const viewUrl = `${serverOrigin}/view/${pageId}`;

    console.log("[3/3] Done!");
    res.json({ viewUrl });
  } catch (err) {
    console.error("Error:", err.message);
    let errorMsg = err.message;
    if (err.response && err.response.status === 403) {
      errorMsg = "このサイトはボット対策により翻訳できません（403 Forbidden）。SUUMO、HOME'S等の物件サイトをお試しください。";
    }
    res.status(500).json({ error: errorMsg });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
