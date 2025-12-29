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

    const {
      format,
      html,
      viewport, // { width, height, deviceScaleFactor }
      screenshotSelector, // e.g. "#canvas"
      png, // { fullPage?: boolean }
      pdf, // pass-through options if needed later
    } = req.body || {};

    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    const width = Number(viewport?.width ?? 1280);
    const height = Number(viewport?.height ?? 720);
    const dpr = Number(viewport?.deviceScaleFactor ?? 2);

    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: dpr,
    });

    const page = await context.newPage();

    // Block Google Fonts so we never hang on font fetches
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    // DO NOT use networkidle (can hang)
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // If your template sets this flag, we wait for it (safe if not present)
    await page.waitForFunction(() => true, { timeout: 1_000 }).catch(() => {});
    await page.waitForTimeout(200);

    let buffer;

    if (format === "pdf") {
      buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
        ...(pdf || {}),
      });
    } else {
      // PNG: best practice — screenshot the canvas element so output is EXACT size
      if (screenshotSelector) {
        await page.waitForSelector(screenshotSelector, { timeout: 10_000 });
        const el = await page.$(screenshotSelector);
        if (!el) throw new Error(`screenshotSelector not found: ${screenshotSelector}`);
        buffer = await el.screenshot({ type: "png" });
      } else {
        buffer = await page.screenshot({ fullPage: !!png?.fullPage, type: "png" });
      }
    }

    await context.close();
    await browser.close();

    console.log(
      `[render] ${format} ok in ${Date.now() - t0}ms, bytes=${buffer.length}, viewport=${width}x${height}@${dpr}`,
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
