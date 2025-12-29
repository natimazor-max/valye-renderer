import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

app.get("/health", (_, res) => res.send("ok"));

async function waitForImages(page, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const done = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      return imgs.every((img) => img.complete);
    });
    if (done) return;
    await page.waitForTimeout(100);
  }
}

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const {
      format,
      html,
      width = 1280,
      height = 720,
      deviceScaleFactor = 2,
      clip = null,
    } = req.body || {};

    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      viewport: { width: Number(width), height: Number(height) },
      deviceScaleFactor: Number(deviceScaleFactor) || 1,
    });

    // Block Google Fonts so we never hang on them
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    // DO NOT use networkidle
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Give layout a moment + ensure images loaded (logo / qr / etc.)
    await page.waitForTimeout(150);
    await waitForImages(page, 6000);

    let buffer;
    if (format === "pdf") {
      buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
    } else {
      // Clip to exact share-safe canvas size
      const shotOpts = {
        type: "png",
        fullPage: false,
      };

      if (clip && clip.width && clip.height) {
        shotOpts.clip = {
          x: Number(clip.x || 0),
          y: Number(clip.y || 0),
          width: Number(clip.width),
          height: Number(clip.height),
        };
      }

      buffer = await page.screenshot(shotOpts);
    }

    await browser.close();

    console.log(`[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}`);

    res.json({
      contentType: format === "pdf" ? "application/pdf" : "image/png",
      contentBase64: Buffer.from(buffer).toString("base64"),
    });
  } catch (e) {
    console.error("[render] error", e);
    res.status(500).send(String(e?.message ?? e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("renderer listening on", port));
