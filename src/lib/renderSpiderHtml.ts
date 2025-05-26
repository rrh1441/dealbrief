/* ──────────────────────────────────────────────────────────────────────────
   src/lib/renderSpiderHtml.ts
   --------------------------------------------------------------------------
   HTML helpers for SpiderPayload
   • renderSpiderHtml()     – turn JSON into foot-noted HTML
   • normalizeCitations()   – inject live <sup> links
   • prepareHtmlForClipboard() – strip links (except in <sup>) & give plain-text
   ------------------------------------------------------------------------ */

   import type { SpiderPayload } from "@/lib/OsintSpiderV2";

   /* superscript injection -------------------------------------------------- */
   export function normalizeCitations(
     html: string,
     citations: { marker: string; url: string }[],
   ): string {
     if (!citations?.length) return html;
     const sup: Record<string, string> = {};
     citations.forEach((c, i) => {
       const n = (i + 1).toString();
       sup[n] =
         `<sup><a class="text-blue-600 underline hover:no-underline" href="${c.url}" target="_blank" rel="noopener noreferrer">${n}</a></sup>`;
     });
     return html
       .replace(/\[(\d+)]/g, (_m, n) => sup[n] ?? n)
       .replace(/[\[\]]/g, ""); // fallback clean-up
   }
   
   /* canonical renderer ----------------------------------------------------- */
   export function renderSpiderHtml(
     data: SpiderPayload,
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
   
     return normalizeCitations(html, data.citations);
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
   