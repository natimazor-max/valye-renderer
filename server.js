import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

app.get("/health", (_, res) => res.send("ok"));

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html, png, pdf } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    // Defaults
    const width = Number(png?.width ?? 1280);
    const height = Number(png?.height ?? 720);
    const deviceScaleFactor = Number(png?.deviceScaleFactor ?? 2);
    const fullPage = Boolean(png?.fullPage ?? false);

    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      viewport: { width, height },
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

    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Give the layout a beat + wait for logo/watermark images (bounded)
    await page.waitForTimeout(150);
    await waitForImages(page, DEFAULT_WAIT_MS);

    let buffer;
    if (format === "pdf") {
      buffer = await page.pdf({
        format: pdf?.format ?? "A4",
        printBackground: true,
        margin: pdf?.margin ?? { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
    } else {
      buffer = await page.screenshot({
        type: "png",
        fullPage,
        // Force exact size capture for share formats
        clip: fullPage ? undefined : { x: 0, y: 0, width, height },
      });
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
