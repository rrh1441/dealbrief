/* ──────────────────────────────────────────────────────────────────────────
   src/lib/DealBriefGeminiPipeline.ts
   --------------------------------------------------------------------------
   HARD CONTRACT
   ─ model returns only:
        { executive: [], highlights: [], funFacts: [], researchNotes: [] }
   ─ each element { text: string, source: number }
   ─ no headings, no prose, no “source 3” strings inside text
   ------------------------------------------------------------------------ */

   import OpenAI from "openai";
   import fetch from "node-fetch"; // Ensure 'node-fetch' and '@types/node-fetch' are installed
   
   export const runtime = "nodejs";
   
   /* ── ENV ------------------------------------------------------------------ */
   const {
     OPENAI_API_KEY,
     SERPER_KEY,
     FIRECRAWL_KEY,
     PROXYCURL_KEY,
   } = process.env;
   
   /* ── CONSTANTS ------------------------------------------------------------ */
   const MODEL_ID = "gpt-4.1-mini-2025-04-14";
   const SERPER = "https://google.serper.dev/search";
   const FIRE = "https://api.firecrawl.dev/v1/scrape";
   const CURL = "https://nubela.co/proxycurl/api/v2/linkedin";
   const MAX_SRC = 25;             // max sources fed to LLM
   const FIRECRAWL_BATCH = 10;     // parallel requests per batch
   const FIRECRAWL_BUDGET_MS = 35_000; // global time budget for all Firecrawl work
   
   /* ── DOMAIN RULES --------------------------------------------------------- */
   const SOCIAL_DOMAINS = [
     "x.com/",
     "twitter.com/",
     "mastodon.social/",
     "facebook.com/",
     "fb.com/",
     "instagram.com/",
   ];
   const GENERIC_NO_SCRAPE = [
     "youtube.com/",
     "youtu.be/",
     "reddit.com/",
     "linkedin.com/pulse/",
     "linkedin.com/posts/",
   ];
   const NO_SCRAPE = [...SOCIAL_DOMAINS, ...GENERIC_NO_SCRAPE];
   
   /* ── TYPES ---------------------------------------------------------------- */
   interface SerpResult { title: string; link: string; snippet?: string }
   interface FirecrawlScrapeResult { article?: { text_content?: string } }
   interface Ymd { year?: number }
   interface LinkedInExperience { company?: string; title?: string; starts_at?: Ymd; ends_at?: Ymd }
   interface ProxyCurlResult { headline?: string; experiences?: LinkedInExperience[] }
   
   interface BriefRow { text: string; source: number }
   interface JsonBrief {
     executive: BriefRow[];
     highlights: BriefRow[];
     funFacts: BriefRow[];
     researchNotes: BriefRow[];
   }
   export interface Citation {
     marker: string;
     url: string;
     title: string;
     snippet: string;
   }
   export interface DealBriefPayload {
     brief: string;
     citations: Citation[];
     tokens: number;
     searches: number;
     searchResults: { url: string; title: string; snippet: string }[];
     possibleSocialLinks: string[];
   }
   
   /* ── HELPERS -------------------------------------------------------------- */
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   
   const postJSON = async <T>(
     url: string,
     body: unknown,
     hdr: Record<string, string>,
   ): Promise<T> =>
     fetch(url, {
       method: "POST",
       headers: { ...hdr, "Content-Type": "application/json" },
       body: JSON.stringify(body),
     }).then(async r => {
       if (!r.ok) throw new Error(`HTTP ${r.status} – ${await r.text()}`);
       return r.json() as Promise<T>;
     });
   
   const yr = (d?: Ymd): string => d?.year?.toString() ?? "?";
   const span = (s?: Ymd, e?: Ymd): string => `${yr(s)} – ${e ? yr(e) : "Present"}`;
   const toks = (s: string): number => Math.ceil(s.length / 4);
   const clean = (t: string): string => t.replace(/\s*\(?\bsource\s*\d+\)?/gi, "").trim();
   const normalize = (c: string): string =>
     c
       .toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|gmbh|corp|corporation|limited|company|co)\s*$/i, "")
       .replace(/[.,]/g, "")
       .trim();
   
   /* ── Firecrawl with retry ------------------------------------------------- */
   const firecrawl = async (url: string): Promise<string | null> => {
     const once = (ms: number) =>
       Promise.race([
         postJSON<FirecrawlScrapeResult>(
           FIRE,
           { url },
           { Authorization: `Bearer ${FIRECRAWL_KEY!}` },
         ),
         new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
       ])
         .then(r => r.article?.text_content ?? null)
         .catch(() => null);
   
     return (await once(5_000)) ?? (await once(10_000));
   };
   
   /* ── HTML helpers --------------------------------------------------------- */
   const pSent = (rows: BriefRow[], cites: Citation[]): string =>
     rows
       .map(r => {
         const c = cites[r.source - 1];
         const sup = c
           ? `<sup><a href="${c.url}" target="_blank" rel="noopener noreferrer">${r.source}</a></sup>`
           : `<sup>[${r.source}]</sup>`;
         return `<p>${clean(r.text)} ${sup}</p>`;
       })
       .join("\n");
   
   const ulRows = (rows: BriefRow[], cites: Citation[]): string =>
     rows.length
       ? `<ul class="list-disc pl-5">\n${rows
           .map(r => {
             const c = cites[r.source - 1];
             const sup = c
               ? `<sup><a href="${c.url}" target="_blank" rel="noopener noreferrer">${r.source}</a></sup>`
               : `<sup>[${r.source}]</sup>`;
             return `  <li>${clean(r.text)} ${sup}</li>`;
           })
           .join("\n")}\n</ul>`
       : "";
   
   const ulJobs = (jobs: string[]): string =>
     jobs.length
       ? `<ul class="list-disc pl-5">\n${jobs.map(j => `  <li>${j}</li>`).join("\n")}\n</ul>`
       : "<p>No job history available.</p>";
   
   /* ── Renderer ------------------------------------------------------------- */
   const renderHtml = (
     name: string,
     org: string,
     json: JsonBrief,
     cites: Citation[],
     jobs: string[],
   ): string => {
     const s = "<p>&nbsp;</p>";
     return `
   <div>
     <h2><strong>Meeting Brief: ${name} – ${org}</strong></h2>
   ${s}<h3><strong>Executive Summary</strong></h3>
   ${pSent(json.executive, cites)}
   ${s}<h3><strong>Job History</strong></h3>
   ${ulJobs(jobs)}
   ${s}<h3><strong>Highlights</strong></h3>
   ${ulRows([...json.highlights, ...json.funFacts], cites)}
   ${s}<h3><strong>Detailed Research Notes</strong></h3>
   ${ulRows(json.researchNotes, cites)}
   </div>`.trim().replace(/^\s*\n/gm, "");
   };
   
   /* ── MAIN ----------------------------------------------------------------- */
   export async function buildDealBriefGemini(
     name: string,
     org: string,
   ): Promise<DealBriefPayload> {
     let serperCalls = 0;
     const serpResults: SerpResult[] = [];
   
     /* ── 1. Initial Serper queries ───────────────────────────────────────── */
     const initialQueries = [
       { q: `"${name}" "${org}" OR "${name}" "linkedin.com/in/"`, num: 10 },
       { q: `"${name}" "${org}" (interview OR profile OR news OR "press release")`, num: 10 },
       { q: `"${name}" (award OR keynote OR webinar OR conference)`, num: 10 },
     ];
   
     for (const q of initialQueries) {
       try {
         const res = await postJSON<{ organic?: SerpResult[] }>(
           SERPER,
           q,
           { "X-API-KEY": SERPER_KEY! },
         );
         serperCalls++;
         if (res.organic) serpResults.push(...res.organic);
       } catch (e) {
         console.warn("Serper error:", e);
       }
     }
   
     /* ── 2. LinkedIn profile ─────────────────────────────────────────────── */
     let linkedIn = serpResults.find(r => r.link.includes("linkedin.com/in/"));
     if (!linkedIn) {
       try {
         const r = await postJSON<{ organic?: SerpResult[] }>(
           SERPER,
           { q: `"${name}" "linkedin.com/in/"`, num: 7 },
           { "X-API-KEY": SERPER_KEY! },
         );
         serperCalls++;
         if (r.organic?.length) {
           linkedIn = r.organic[0];
           serpResults.push(linkedIn);
         }
       } catch (e) {
         console.warn("LinkedIn dedicated search error:", e);
       }
     }
     if (!linkedIn?.link) throw new Error(`LinkedIn profile not found for ${name}`);
   
     /* ── 3. ProxyCurl ────────────────────────────────────────────────────── */
     const curlRes = await fetch(
       `${CURL}?linkedin_profile_url=${encodeURIComponent(linkedIn.link)}`,
       { headers: { Authorization: `Bearer ${PROXYCURL_KEY!}` } },
     );
     if (!curlRes.ok)
       throw new Error(`ProxyCurl ${curlRes.status} – ${await curlRes.text()}`);
     const proxyData = (await curlRes.json()) as ProxyCurlResult; // fixed typing
   
     const jobTimeline = (proxyData.experiences ?? []).map(
       e =>
         `${e.title ?? "Role"} — ${e.company ?? "Company"} (${span(
           e.starts_at,
           e.ends_at,
         )})`,
     );
   
     /* ── 4. Extra Serper queries for prior orgs ──────────────────────────── */
     const companies = (proxyData.experiences ?? [])
       .map(e => e.company)
       .filter(Boolean) as string[];
   
     const uniqueCompanies = companies
       .filter(
         (c, i, arr) =>
           i === arr.findIndex(x => normalize(x) === normalize(c)) &&
           normalize(c) !== normalize(org),
       )
       .slice(0, 3);
   
     for (const c of uniqueCompanies) {
       try {
         const res = await postJSON<{ organic?: SerpResult[] }>(
           SERPER,
           { q: `"${name}" "${c}"`, num: 10 },
           { "X-API-KEY": SERPER_KEY! },
         );
         serperCalls++;
         if (res.organic) serpResults.push(...res.organic);
       } catch (e) {
         console.warn(`Serper company query error (${c}):`, e);
       }
     }
   
     /* ── 5. Build source lists ───────────────────────────────────────────── */
     const deduped = Array.from(new Map(serpResults.map(r => [r.link, r])).values());
     const sources = deduped
       .filter(
         r =>
           !NO_SCRAPE.some(sub => r.link.includes(sub)) ||
           r.link.includes("linkedin.com/in/"),
       )
       .slice(0, MAX_SRC);
   
     const possibleSocialLinks = SOCIAL_DOMAINS
       .flatMap(d => deduped.filter(r => r.link.includes(d)).map(r => r.link))
       .filter((l, i, arr) => arr.indexOf(l) === i);
   
     /* ── 6. Firecrawl in parallel batches with global budget ─────────────── */
     const extracts: string[] = new Array(sources.length).fill("");
     let timeSpent = 0;
     for (let i = 0; i < sources.length; i += FIRECRAWL_BATCH) {
       const remainingBudget = FIRECRAWL_BUDGET_MS - timeSpent;
       if (remainingBudget <= 0) {
         for (let j = i; j < sources.length; j++) {
           const s = sources[j];
           extracts[j] = s.link.includes("linkedin.com/in/")
             ? `LinkedIn headline: ${proxyData.headline ?? "N/A"}. URL: ${s.link}.`
             : `${s.title}. ${s.snippet ?? ""}`;
         }
         break;
       }
   
       const batch = sources
         .slice(i, i + FIRECRAWL_BATCH)
         .map((s, idxInBatch) => ({ src: s, globalIdx: i + idxInBatch }));
   
       const tBatchStart = Date.now();
       await Promise.all(
         batch.map(async b => {
           const s = b.src;
           const g = b.globalIdx;
           if (s.link.includes("linkedin.com/in/")) {
             extracts[g] = `LinkedIn headline: ${proxyData.headline ?? "N/A"}. URL: ${s.link}.`;
             return;
           }
           if (NO_SCRAPE.some(sub => s.link.includes(sub))) {
             extracts[g] = `${s.title}. ${s.snippet ?? ""}`;
             return;
           }
           const txt = await firecrawl(s.link);
           if (txt) {
             const combined = txt.includes(s.snippet ?? "")
               ? txt
               : `${txt}\n${s.title}. ${s.snippet ?? ""}`;
             extracts[g] = combined.slice(0, 3000);
           } else {
             extracts[g] = `${s.title}. ${s.snippet ?? ""}`;
           }
         }),
       );
       timeSpent += Date.now() - tBatchStart;
     }
   
     /* ── 7. Build LLM prompt ─────────────────────────────────────────────── */
     const srcBlock = sources
       .map(
         (s, idx) => `SOURCE_${idx + 1} URL: ${s.link}\nCONTENT:\n${extracts[idx]}`,
       )
       .join("\n\n---\n\n");
   
     const template = `{
     "executive":[{"text":"","source":1}],
     "highlights":[{"text":"","source":1}],
     "funFacts":[{"text":"","source":1}],
     "researchNotes":[{"text":"","source":1}]
   }`;
   
     const prompt = `
   Return ONLY JSON matching TEMPLATE.
   Provide 4–6 distinct items in "researchNotes" if sources permit.
   
   ### TEMPLATE
   ${template}
   
   ### EMPLOYMENT TIMELINE
   ${jobTimeline.join("\n")}
   
   ### SOURCES
   ${srcBlock}`.trim();
   
     /* ── 8. OpenAI call ───────────────────────────────────────────────────── */
     const llmResp = await ai.chat.completions.create({
       model: MODEL_ID,
       temperature: 0,
       response_format: { type: "json_object" },
       messages: [{ role: "user", content: prompt }],
     });
   
     let jsonBrief: JsonBrief = {
       executive: [],
       highlights: [],
       funFacts: [],
       researchNotes: [],
     };
     try {
       jsonBrief = JSON.parse(llmResp.choices[0].message.content ?? "{}");
     } catch (e) {
       console.error("LLM JSON parse error", e);
     }
   
     /* ── 9. Deduplicate rows (except researchNotes) ──────────────────────── */
     const uniq = (rows?: BriefRow[]) =>
       Array.from(
         new Map(
           (rows ?? []).map(r => [
             clean(r.text).toLowerCase(),
             { ...r, text: clean(r.text) },
           ]),
         ).values(),
       );
   
     jsonBrief.executive = uniq(jsonBrief.executive);
     jsonBrief.highlights = uniq(jsonBrief.highlights);
     jsonBrief.funFacts = uniq(jsonBrief.funFacts);
     // researchNotes left as-is to allow similar notes
   
     /* ── 10. Citations ───────────────────────────────────────────────────── */
     const citations: Citation[] = sources.map((s, idx) => ({
       marker: `[${idx + 1}]`,
       url: s.link,
       title: s.title,
       snippet: extracts[idx].slice(0, 300) + (extracts[idx].length > 300 ? "..." : ""),
     }));
   
     /* ── 11. HTML report ─────────────────────────────────────────────────── */
     const htmlBrief = renderHtml(
       name,
       org,
       jsonBrief,
       citations,
       jobTimeline,
     );
   
     /* ── 12. Payload ─────────────────────────────────────────────────────── */
     return {
       brief: htmlBrief,
       citations,
       tokens: toks(prompt) + toks(JSON.stringify(jsonBrief)),
       searches: serperCalls,
       searchResults: sources.map((s, idx) => ({
         url: s.link,
         title: s.title,
         snippet: extracts[idx].slice(0, 300) + (extracts[idx].length > 300 ? "..." : ""),
       })),
       possibleSocialLinks,
     };
   }