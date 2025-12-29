import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

// Tune these safely
const SETCONTENT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 120_000; // <-- fix: default is 30s; too low for big + blur
const DEFAULT_WAIT_MS = 2_500;

app.get("/health", (_, res) => res.send("ok"));

async function waitForImages(page, maxMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const allDone = await page.evaluate(() => {
      const imgs = Array.from(document.images || []);
      // If there are no images, we’re done.
      if (!imgs.length) return true;
      return imgs.every((img) => img.complete);
    });
    if (allDone) return true;
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

    // Defaults
    const width = Number(png?.width ?? 1280);
    const height = Number(png?.height ?? 720);

    // OPTIONAL: cap deviceScaleFactor for very tall shots to avoid timeouts/CPU spikes
    // (You can remove this if you want exact dSF always.)
    let deviceScaleFactor = Number(png?.deviceScaleFactor ?? 2);
    if (height >= 1600 && deviceScaleFactor > 1.5) deviceScaleFactor = 1.5;

    const fullPage = Boolean(png?.fullPage ?? false);

    browser = await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu", // helps on some hosts
      ],
    });

    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor,
    });

    // Speed/stability tweaks
    page.setDefaultTimeout(SCREENSHOT_TIMEOUT_MS);

    // Block Google fonts to avoid hangs
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: SETCONTENT_TIMEOUT_MS });

    // Disable animations/transitions (prevents “never settles” rendering edge cases)
    await page.addStyleTag({
      content: `
        * { animation: none !important; transition: none !important; }
        html { scroll-behavior: auto !important; }
      `,
    });

    // Give the layout a beat + wait for <img> loads (bounded)
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
        timeout: SCREENSHOT_TIMEOUT_MS, // <-- critical
        animations: "disabled",
      });
    }

    await browser.close();
    browser = null;

    console.log(
      `[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}, ` +
      `viewport=${width}x${height}, dSF=${deviceScaleFactor}, fullPage=${fullPage}`
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
