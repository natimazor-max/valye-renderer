import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

// Defaults (can override per request body)
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const DEFAULT_SCALE = Number(process.env.RENDER_DEVICE_SCALE || "2"); // 2 = crisp PNG
const DEFAULT_WAIT_MS = Number(process.env.RENDER_WAIT_MS || "2500"); // wait for images
const NAV_TIMEOUT_MS = Number(process.env.RENDER_NAV_TIMEOUT_MS || "30000");

app.get("/health", (_, res) => res.send("ok"));

async function waitForImages(page, maxMs) {
  // Wait until all <img> elements are complete (or errored), with a timeout.
  await Promise.race([
    page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        })
      );
    }),
    new Promise((resolve) => setTimeout(resolve, maxMs)),
  ]);
}

app.post("/render", async (req, res) => {
  const t0 = Date.now();

  let browser;
  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html, options } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    // Optional per-request overrides
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
    const deviceScaleFactor = Number(options?.deviceScaleFactor ?? DEFAULT_SCALE);
    const fullPage = options?.fullPage ?? true;

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      viewport,
      deviceScaleFactor,
    });

    // Block external Google Fonts so we never hang on font fetches.
    // (Your new HTML template uses system fonts, but keep this as safety.)
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    // Render HTML quickly (no networkidle)
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    // Give the layout a beat + wait for logo/watermark images (bounded)
    await page.waitForTimeout(150);
    await waitForImages(page, DEFAULT_WAIT_MS);

    let buffer;
    if (format === "pdf") {
      buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
        preferCSSPageSize: true,
      });
    } else {
      buffer = await page.screenshot({
        fullPage,
        type: "png",
        // If you ever want to crop instead of fullPage, you can pass:
        // clip: { x: 0, y: 0, width: 1200, height: 628 }
      });
    }

    await page.close();
    await browser.close();
    browser = null;

    console.log(
      `[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}, scale=${deviceScaleFactor}, viewport=${viewport.width}x${viewport.height}`
    );

    res.json({
      contentType: format === "pdf" ? "application/pdf" : "image/png",
      contentBase64: Buffer.from(buffer).toString("base64"),
    });
  } catch (e) {
    console.error("[render] error", e);
    try {
      if (browser) await browser.close();
    } catch {}
    res.status(500).send(String(e?.message ?? e));
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("renderer listening on", port));
