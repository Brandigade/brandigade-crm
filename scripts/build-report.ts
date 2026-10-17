// Builds the handover report from docs/report/report.html:
//   docs/report/Brandigade-CRM-update.pdf   (Chromium print, A4)
//   docs/report/Brandigade-CRM-update.docx  (editable, via pandoc)
//
//   npx tsx scripts/build-report.ts
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs", "report");
const html = path.join(dir, "report.html");
const pdf = path.join(dir, "Brandigade-CRM-update.pdf");
const docx = path.join(dir, "Brandigade-CRM-update.docx");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(html).href, { waitUntil: "load" });
await page.pdf({
  path: pdf,
  format: "A4",
  margin: { top: "22mm", bottom: "20mm", left: "22mm", right: "22mm" },
  printBackground: false,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate:
    '<div style="font-family:Arial,sans-serif;font-size:8px;color:#000;width:100%;text-align:center;">Brandigade CRM update · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
});
await browser.close();

execFileSync("pandoc", [html, "-f", "html", "-t", "docx", "-o", docx, "--resource-path", dir], { stdio: "inherit" });
console.log("Wrote", path.relative(root, pdf), "and", path.relative(root, docx));
