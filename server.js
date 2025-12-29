import express from "express";
import { chromium } from "playwright";
import QRCode from "qrcode";

const app = express();
app.use(express.json({ limit: "25mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

app.get("/health", (_, res) => res.send("ok"));

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  try {
    const provided = req.header("x-render-secret") || "";
    if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

    const { format, html, viewport, screenshot, qr } = req.body || {};
    if (!html || !format) return res.status(400).send("Missing html/format");
    if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

    // Optional QR: generate data URI here (no canvas needed)
    let finalHtml = String(html);
    if (qr?.text) {
      const size = Number(qr?.size ?? 92);
      const dataUrl = await QRCode.toDataURL(String(qr.text), {
        width: size,
        margin: 0,
        errorCorrectionLevel: "M",
      });
      finalHtml = finalHtml.replaceAll("__VALYE_QR_DATA_URI__", dataUrl);
    } else {
      // fallback: 1x1 transparent png
      finalHtml = finalHtml.replaceAll(
        "__VALYE_QR_DATA_URI__",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6r2nqkAAAAASUVORK5CYII=",
      );
    }

    const vp = {
      width: Math.max(320, Math.min(4000, Number(viewport?.width ?? 1280))),
      height: Math.max(320, Math.min(6000, Number(viewport?.height ?? 720))),
      deviceScaleFactor: Math.max(1, Math.min(3, Number(viewport?.dpr ?? 1))),
    };

    const browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
    });

    // Block Google Fonts so we never hang on font fetches
    await page.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        return route.abort();
      }
      return route.continue();
    });

    await page.setContent(finalHtml, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(250);

    let buffer;

    if (format === "pdf") {
      buffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
    } else {
      // PNG
      const selector = screenshot?.selector;
      if (selector) {
        const loc = page.locator(selector);
        const count = await loc.count();
        if (!count) throw new Error(`screenshot selector not found: ${selector}`);
        buffer = await loc.first().screenshot({ type: "png" });
      } else {
        const fullPage = screenshot?.fullPage !== false;
        buffer = await page.screenshot({ fullPage, type: "png" });
      }
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
