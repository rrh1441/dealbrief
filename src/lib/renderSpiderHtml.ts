/* ──────────────────────────────────────────────────────────────────────────
   src/lib/renderSpiderHtml.ts
   --------------------------------------------------------------------------
   HTML helpers for SpiderPayload
   • renderSpiderHtml()     – turn JSON into foot-noted HTML
   • normalizeCitations()   – inject live <sup> links
   • prepareHtmlForClipboard() – strip links (except in <sup>) & give plain-text
   ------------------------------------------------------------------------ */

   import type { OsintSpiderPayload, OsintSpiderPayloadV4, ReportBullet, FileForManualReview, Citation, SectionOutput } from "@/lib/OsintSpiderV2";

   /* superscript injection -------------------------------------------------- */
   export function normalizeCitations(
     html: string,
     citations: { marker: string; url: string }[],
   ): string {
     if (!citations?.length) return html;
     const sup: Record<string, string> = {};
     citations.forEach((c) => {
       const n = c.marker.replace(/\[|\]/g, "");
       sup[n] =
         `<sup><a class="text-blue-600 underline hover:no-underline" href="${c.url}" target="_blank" rel="noopener noreferrer">${n}</a></sup>`;
     });
     return html
       .replace(/<sup>\[(\d+)\]<\/sup>/g, (_m, n) => sup[n] ?? `[${n}]`)
       .replace(/\[(\d+)\]/g, (_m, n) => sup[n] ?? `[${n}]`);
   }
   
   /* canonical renderer ----------------------------------------------------- */
   export function renderSpiderHtml(
     data: OsintSpiderPayload,
     opts: { showEmpty?: boolean } = {},
   ): string {
     const bulletHtml = (b: typeof data.sections[0]["bullets"][0]) =>
       `<li>${b.text} <sup>[${b.source}]</sup></li>`;
   
     const sectionHtml = (s: typeof data.sections[0]) => {
       if (!opts.showEmpty && s.bullets.length === 0) return "";
       return `
         <h3><strong>${s.name} — ${s.summary}</strong></h3>
         <ul class="list-disc pl-5">
           ${s.bullets.map(bulletHtml).join("\n")}
         </ul>`;
     };
   
     const html = `
   <div>
     <h2><strong>Due-Diligence Brief: ${data.company}</strong></h2>
     <p>&nbsp;</p>
     <h3><strong>Executive Summary</strong></h3>
     <p>${data.summary}</p>
     <p>&nbsp;</p>
     ${data.sections.map(sectionHtml).join("\n<p>&nbsp;</p>\n")}
   </div>`.replace(/\n\s+\n/g, "\n");
   
     return normalizeCitations(html, data.citations as { marker: string; url: string }[]);
   }
   
   /* renderer for OsintSpiderPayloadV4 -------------------------------------- */
   export function renderSpiderHtmlV4(
     data: OsintSpiderPayloadV4,
     opts: { showEmpty?: boolean } = {},
   ): string {
     const bulletHtmlV4 = (b: ReportBullet) =>
       `<li>${b.text} (Severity: ${b.severity}, Origin: ${b.origin}) ${b.quote ? `<blockquote>${b.quote}</blockquote>` : ""} <sup>${b.citationMarker}</sup></li>`;
   
     const sectionHtmlV4 = (s: SectionOutput) => {
       if (!opts.showEmpty && s.bullets.length === 0 && (!s.summary || s.summary.toLowerCase().includes("no specific findings") || s.summary.toLowerCase().includes("insufficient to summarize")) ) return "";
       return `
         <h3><strong>${s.name} — ${s.summary}</strong></h3>
         ${s.bullets.length > 0 ? `<ul class="list-disc pl-5">
           ${s.bullets.map(bulletHtmlV4).join("\n")}
         </ul>` : "<p><em>No specific bullet points generated for this section.</em></p>"}`;
     };
   
     const filesHtmlV4 = (f: FileForManualReview) =>
       `<li><a href="${f.url}" target="_blank" rel="noopener noreferrer">${f.title}</a> - ${f.predictedInterest} <sup>${f.citationMarker}</sup></li>`;
   
     let html = `
   <div>
     <h2><strong>Due-Diligence Brief: ${data.company} (V4)</strong></h2>
     <p>&nbsp;</p>
     <h3><strong>Executive Summary</strong></h3>
     <p>${data.summary}</p>
     <p>&nbsp;</p>
     ${data.sections.map(sectionHtmlV4).join("\n<p>&nbsp;</p>\n")}
   `;
   
     if (data.filesForManualReview && data.filesForManualReview.length > 0) {
       html += `
     <p>&nbsp;</p>
     <h3><strong>Files Flagged for Manual Review</strong></h3>
     <ul class="list-disc pl-5">
       ${data.filesForManualReview.map(filesHtmlV4).join("\n")}
     </ul>`;
     }
   
     html += `
   </div>`;
     html = html.replace(/\n\s+\n/g, "\n");
   
     return normalizeCitations(html, data.citations as Citation[]);
   }
   
   /* clipboard helper ------------------------------------------------------- */
   export function prepareHtmlForClipboard(raw: string) {
     const div = document.createElement("div");
     div.innerHTML = raw.replace(/<p>&nbsp;<\/p>/g, "");
   
     div.querySelectorAll<HTMLAnchorElement>("a").forEach(a => {
       if (a.closest("sup")) return;       // keep links in <sup>
       a.removeAttribute("href");
       a.style.textDecoration = "none";
       a.style.color = "inherit";
     });
   
     return {
       html: div.innerHTML,
       text: div.innerText,
     };
   }
   