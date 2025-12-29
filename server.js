import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

// Defaults (can override per request body)
const DEFAULT_VIEWPORT = {
  width: Number(process.env.RENDER_DEFAULT_WIDTH || "1280"),
  height: Number(process.env.RENDER_DEFAULT_HEIGHT || "720"),
};
const DEFAULT_SCALE = Number(process.env.RENDER_DEVICE_SCALE || "2"); // crisp PNG
const DEFAULT_WAIT_MS = Number(process.env.RENDER_WAIT_MS || "2500"); // wait for images
const NAV_TIMEOUT_MS = Number(process.env.RENDER_NAV_TIMEOUT_MS || "30000");

app.get("/health", (_, res) => res.send("ok"));

async function waitForImages(page, maxMs) {
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

function normalizeOptions(format, body) {
  // Preferred: body.options
  let options = body?.options ? { ...body.options } : null;

  // Back-compat: if caller sends {png:{...}} or {pdf:{...}}, map it into options
  if (!options) {
    if (format === "png" && body?.png) {
      const w = Number(body.png.width || body.png.viewport?.width || DEFAULT_VIEWPORT.width);
      const h = Number(body.png.height || body.png.viewport?.height || DEFAULT_VIEWPORT.height);
      options = {
        viewport: { width: w, height: h },
        deviceScaleFactor: Number(body.png.deviceScaleFactor ?? DEFAULT_SCALE),
        fullPage: body.png.fullPage ?? false,
        waitMs: Number(body.png.waitMs ?? DEFAULT_WAIT_MS),
      };
    } else if (format === "pdf" && body?.pdf) {
      options = {
        waitMs: Number(body.pdf.waitMs ?? DEFAULT_WAIT_MS),
      };
    }
  }

  // Apply defaults
  const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
  const deviceScaleFactor = Number(options?.deviceScaleFactor ?? DEFAULT_SCALE);
  const fullPage = options?.fullPage ?? true;
  const waitMs = Number(options?.waitMs ?? DEFAULT_WAIT_MS);

  return { viewport, deviceScaleFactor, fullPage, waitMs };
}

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  let browser;

  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    const { viewport, deviceScaleFactor, fullPage, waitMs } = normalizeOptions(format, req.body);

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({ viewport, deviceScaleFactor });

    // Block external Google Fonts so we never hang on font fetches.
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    await page.waitForTimeout(150);
    await waitForImages(page, waitMs);

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
