import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

const SETCONTENT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_MS = 2_500;

app.get("/health", (_, res) => res.send("ok"));

async function waitForImages(page, maxMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      if (!imgs.length) return true;
      // treat failed images as "done" so we don't hang on blocked hosts
      return imgs.every((img) => img.complete);
    });
    if (done) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  let browser;

  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html, png, pdf } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    const width = Number(png?.width ?? 1280);
    const height = Number(png?.height ?? 720);
    let deviceScaleFactor = Number(png?.deviceScaleFactor ?? 2);
    const fullPage = Boolean(png?.fullPage ?? false);

    // optional: avoid super heavy renders for tall story images
    if (height >= 1600 && deviceScaleFactor > 1.5) deviceScaleFactor = 1.5;

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor,
    });

    page.setDefaultTimeout(SCREENSHOT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(SCREENSHOT_TIMEOUT_MS);

    // Block Google font fetches
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: SETCONTENT_TIMEOUT_MS });

    // Disable animations/transitions
    await page.addStyleTag({
      content: `
        * { animation: none !important; transition: none !important; }
        html { scroll-behavior: auto !important; }
      `,
    });

    await page.waitForTimeout(200);
    await waitForImages(page, DEFAULT_WAIT_MS);

    let buffer;
    if (format === "pdf") {
      buffer = await page.pdf({
        format: pdf?.format ?? "A4",
        printBackground: true,
        margin: pdf?.margin ?? { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
        timeout: SCREENSHOT_TIMEOUT_MS,
      });
    } else {
      buffer = await page.screenshot({
        type: "png",
        fullPage,
        clip: fullPage ? undefined : { x: 0, y: 0, width, height },
        timeout: SCREENSHOT_TIMEOUT_MS,
        animations: "disabled",
      });
    }

    await browser.close();
    browser = null;

    console.log(
      `[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}, viewport=${width}x${height}, dSF=${deviceScaleFactor}`
    );

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
