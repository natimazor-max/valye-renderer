import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "15mb" }));

const SECRET = process.env.RENDERER_SECRET || "";

app.get("/health", (_, res) => res.send("ok"));

app.post("/render", async (req, res) => {
    try {
          const provided = req.header("x-render-secret") || "";
          if (!SECRET || provided !== SECRET) return res.status(401).send("Unauthorized");

      const { format, html } = req.body || {};
          if (!html || !format) return res.status(400).send("Missing html/format");
          if (!["pdf", "png"].includes(format)) return res.status(400).send("format must be pdf|png");

      const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
          const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
          await page.setContent(html, { waitUntil: "networkidle" });

      let buffer;
          if (format === "pdf") {
                  buffer = await page.pdf({
                            format: "A4",
                            printBackground: true,
                            margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" }
                  });
          } else {
                  buffer = await page.screenshot({ fullPage: true, type: "png" });
          }

      await browser.close();

      res.json({
              contentType: format === "pdf" ? "application/pdf" : "image/png",
              contentBase64: Buffer.from(buffer).toString("base64")
      });
    } catch (e) {
          res.status(500).send(String(e?.message ?? e));
    }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("renderer listening on", port));
