import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

app.get("/health", (_, res) => res.send("ok"));

app.post("/render", async (req, res) => {
  const t0 = Date.now();

  let browser;
  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html, png, pdf } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    // PNG options (honor width/height for “share-safe crops”)
    const pngWidth = Number(png?.width) || 1280;
    const pngHeight = Number(png?.height) || 720;
    const deviceScaleFactor = Number(png?.deviceScaleFactor) || 2;
    const fullPage = png?.fullPage === true; // default false for exact canvas captures

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      viewport: { width: pngWidth, height: pngHeight },
      deviceScaleFactor,
    });

    // Block external font fetches so we never hang on Google Fonts
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    // DO NOT use networkidle
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Give images a moment to load (logo + QR)
    await page.waitForFunction(() => {
      const imgs = Array.from(document.images || []);
      return imgs.every((img) => img.complete);
    }, { timeout: 3500 }).catch(() => {});
    await page.waitForTimeout(150);

    let buffer;
    if (format === "pdf") {
      buffer = await page.pdf({
        format: pdf?.format || "A4",
        printBackground: true,
        margin: pdf?.margin || { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
    } else {
      buffer = await page.screenshot({
        type: "png",
        fullPage, // for “share crops” we want false (viewport-only)
      });
    }

    await browser.close();
    browser = null;

    console.log(`[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}`);

    res.json({
      contentType: format === "pdf" ? "application/pdf" : "image/png",
      contentBase64: Buffer.from(buffer).toString("base64"),
    });
  } catch (e) {
    console.error("[render] error", e);
    try { if (browser) await browser.close(); } catch {}
    res.status(500).send(String(e?.message ?? e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("renderer listening on", port));
