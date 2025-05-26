/* ──────────────────────────────────────────────────────────────────────────
   src/lib/OsintSpiderV2.ts
   --------------------------------------------------------------------------
   Web-only due-diligence pipeline
   • Serper search (≤ 600)
   • Firecrawl scrape (≤ 200)
   • ProxyCurl LinkedIn enrich (≤ 10)
   • GPT-4.1-mini summaries (budget ≤ $2)
   • Per-section summaries + global executive summary
   • ≤ 20 bullets per section, 6 thematic sections
   ------------------------------------------------------------------------ */

   import { createHash } from "node:crypto";
   import { performance } from "node:perf_hooks";
   import fetch from "node-fetch";
   import { z } from "zod";
   import OpenAI from "openai";
   
   export const runtime = "nodejs";
   
   /* ── ENV ------------------------------------------------------------------ */
   const {
     SERPER_KEY,
     FIRECRAWL_KEY,
     PROXYCURL_KEY,
     OPENAI_API_KEY,
   } = process.env;
   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
     throw new Error("Missing required env vars.");
   }
   
   /* ── CONSTANTS ------------------------------------------------------------ */
   const SERPER  = "https://google.serper.dev/search";
   const FIRE    = "https://api.firecrawl.dev/v1/scrape";
   const CURL_P  = "https://nubela.co/proxycurl/api/v2/linkedin";
   const CURL_C  = "https://nubela.co/proxycurl/api/linkedin/company";
   
   const MAX_SERPER    = 600;
   const MAX_SERP_PAGE = 10;
   const MAX_FIRECRAWL = 200;
   const MAX_CURL      = 10;
   
   const BATCH_FIRE    = 20;
   const FIRE_TIMEOUT  = 6_000;
   
   const WALL_MS       = 12 * 60_000;
   const MODEL_ID      = "gpt-4.1-mini-2025-04-14";
   const USD_CAP       = 2.0;
   
   const BULLET_CAP    = 20;
   const BULLET_LEN    = 300;
   const EXEC_OUT_TOK  = 250;
   const SECT_OUT_TOK  = 120;
   
   const TOK_CAP       = 25_000; // absolute safety
   
   /* ── TYPES ---------------------------------------------------------------- */
   type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
   interface Bullet { text: string; source: number; sev: Sev }
   interface Section { name: string; summary: string; bullets: Bullet[] }
   interface Citation { marker: string; url: string; title: string; snippet: string }
   
   export interface SpiderPayload {
     company: string;
     domain:  string;
     generated: string;
     summary: string;
     sections: Section[];
     citations: Citation[];
     cost: { serper: number; firecrawl: number; proxycurl: number; llm: number; total: number };
   }
   
   /* ── INPUT --------------------------------------------------------------- */
   const inputSchema = z.object({
     company_name: z.string().trim().min(1),
     domain:       z.string().trim().min(3),
     owner_names:  z.array(z.string().trim()).optional(),
   });
   
   /* ── HELPERS -------------------------------------------------------------- */
   const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
   const trunc  = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 3) + "…");
   const tokens = (s: string) => Math.ceil(s.length / 3.5);
   const price  = (inTok = 0, outTok = 0) => inTok * 0.00040 + outTok * 0.00160; // 4.1-mini
   
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   let usdSpent = 0;
   
   async function llm(prompt: string, ctx: string, outTok: number): Promise<string> {
     const inTok = tokens(prompt) + tokens(ctx);
     const est = price(inTok, outTok);
     if (usdSpent + est > USD_CAP) return "NSTR";
     const r = await ai.chat.completions.create({
       model: MODEL_ID,
       temperature: 0.25,
       max_tokens: outTok,
       messages: [
         { role: "system", content: prompt },
         { role: "user", content: ctx },
       ],
     });
     usdSpent += price(inTok, r.usage?.completion_tokens ?? outTok);
     return r.choices[0].message.content!.trim();
   }
   
   const postJson = async <T>(url: string, body: unknown, hdr: Record<string,string>) =>
     fetch(url, {
       method: "POST",
       headers: { ...hdr, "Content-Type": "application/json" },
       body: JSON.stringify(body),
     }).then(async r => {
       if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
       return r.json() as Promise<T>;
     });
   
   /* ── REGEX & SCORING ------------------------------------------------------ */
   const RE_EMAIL  = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
   const RE_PHONE  = /\b\+?\d[\d\s().-]{6,}\d\b/g;
   const RE_SECRET = /\b(api[_-]?key|token|secret|password|authorization)\b/i;
   const RE_PDFXLS = /\.(pdf|xlsx)$/i;
   
   const sevRank: Record<Sev, number> = { CRITICAL:1, HIGH:2, MEDIUM:3, LOW:4 };
   const classify = (s: string): Sev => {
     const t = s.toLowerCase();
     if (t.match(RE_SECRET)) return "CRITICAL";
     if (t.match(/breach|leak|lawsuit|fraud|ransomware|invoice|pii/)) return "HIGH";
     if (t.match(/index of/) || t.match(RE_PDFXLS)) return "MEDIUM";
     return "LOW";
   };
   
   const scoreSerp = (r: { link:string; title:string; snippet?:string }, domain:string, canon:string): number => {
     let s = 0;
     if (r.link.includes(domain)) s += 0.3;
     if ((r.snippet||"").match(RE_EMAIL) || (r.snippet||"").match(RE_PHONE)) s += 0.2;
     if (r.link.match(/\.gov|\.edu|\.mil/) || RE_PDFXLS.test(r.link)) s += 0.2;
     if ((r.snippet||"").match(/invoice|contract|apikey|secret|password/)) s += 0.2;
     if (r.title.match(/index of|error/i)) s += 0.1;
     return s;
   };
   
   /* ── MAIN ----------------------------------------------------------------- */
   export async function runSpider(raw: unknown): Promise<SpiderPayload> {
     const t0 = performance.now();
     const { company_name, domain, owner_names=[] } = inputSchema.parse(raw);
   
     const canon = company_name
       .toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,'')
       .replace(/[.,']/g,'')
       .trim();
   
     /* storage */
     const bulletsBy: Record<string,Bullet[]> = {
       Corporate:[], Legal:[], Cyber:[], Reputation:[], Leadership:[], Misc:[],
     };
     const citations: Citation[] = [];
   
     let serperCalls=0, fireCalls=0, curlCalls=0;
   
     /* queue of dorks */
     const queue: string[] = [
       `"${canon}"`,
       `"${canon}" site:${domain}`,
       `"${domain}" ("breach" OR "leak" OR "lawsuit")`,
       `"${canon}" filetype:pdf`,
       `"${canon}" filetype:xlsx`,
       `"${canon}" site:*.gov`,
       `"@${domain}" site:github.com`,
     ];
     owner_names.forEach(o=>queue.push(`"${o}" "${canon}"`));
     const seenQ = new Set(queue);
     const seenUrl = new Set<string>();
   
     /* results store */
     interface Res { link:string; title:string; snippet?:string; score:number }
     const top: Res[] = [];
   
     /* 1 ───────── SERPER BFS */
     while(queue.length && serperCalls<MAX_SERPER && performance.now()-t0<WALL_MS) {
       const q = queue.shift()!;
       const data = await postJson<{organic?:any[]}>(
         SERPER, { q, num: MAX_SERP_PAGE, gl:"us", hl:"en" }, { "X-API-KEY": SERPER_KEY! },
       ).catch(()=>({}));
       serperCalls++;
   
       for(const o of data.organic??[]) {
         const url = o.link as string;
         if (!url || seenUrl.has(url)) continue;
         seenUrl.add(url);
   
         const score = scoreSerp(o, domain, canon);
         top.push({ link:url, title:o.title, snippet:o.snippet, score });
   
         /* host expansion */
         try {
           const host = new URL(url).hostname;
           if(!seenQ.has(host)) {
             seenQ.add(host);
             queue.push(`"${canon}" site:${host}`);
           }
         } catch { /* ignore */ }
       }
     }
   
     top.sort((a,b)=>b.score-a.score);
   
     /* 2 ───────── PROXYCURL enrichment (company + up to 9 persons) */
     const liCompany = top.find(r=>r.link.includes("linkedin.com/company/"));
     if(liCompany && curlCalls<MAX_CURL) {
       const res = await fetch(`${CURL_C}?url=${encodeURIComponent(liCompany.link)}`,
         { headers:{ Authorization:`Bearer ${PROXYCURL_KEY!}` } });
       curlCalls++;
       if(res.ok){
         const j = await res.json() as { industry?:string; founded_year?:number };
         top.unshift({
           link: liCompany.link,
           title: liCompany.title,
           snippet: `${j.industry??""} ${j.founded_year??""}`.trim(),
           score: 0.6,
         });
       }
     }
   
     for(const owner of owner_names.slice(0,9)){
       if(curlCalls>=MAX_CURL) break;
       let prof = top.find(r=>r.link.includes("linkedin.com/in/") && r.title.toLowerCase().includes(owner.toLowerCase()));
       if(!prof){
         const data = await postJson<{organic?:any[]}>(
           SERPER, { q:`"${owner}" "linkedin.com/in/"`, num:5, gl:"us", hl:"en" },
           { "X-API-KEY": SERPER_KEY! },
         ).catch(()=>({}));
         serperCalls++;
         prof = data.organic?.[0];
         if(prof) top.push({ ...prof, score:0.5 });
       }
       if(prof){
         const res = await fetch(`${CURL_P}?linkedin_profile_url=${encodeURIComponent(prof.link)}`,
           { headers:{ Authorization:`Bearer ${PROXYCURL_KEY!}` } });
         curlCalls++;
         if(res.ok){
           const j = await res.json() as { headline?:string };
           top.unshift({ link:prof.link, title:owner+" – LinkedIn", snippet:j.headline, score:0.6 });
         }
       }
     }
   
     /* 3 ───────── FIRECRAWL scrape top URLs */
     const targets = top.slice(0, MAX_FIRECRAWL);
     const fireText = new Map<string,string>(); // sha(url) -> text
   
     for(let i=0;i<targets.length && fireCalls<MAX_FIRECRAWL;i+=BATCH_FIRE){
       const batch = targets.slice(i, i+BATCH_FIRE);
       await Promise.all(batch.map(async r=>{
         if(performance.now()-t0>=WALL_MS) return;
         const txt = await Promise.race([
           postJson<{article?:{text_content?:string}}>(
             FIRE, { url:r.link, depth:0 }, { Authorization:`Bearer ${FIRECRAWL_KEY!}` }),
           new Promise<null>((_,rej)=>setTimeout(()=>rej("timeout"), FIRE_TIMEOUT)),
         ]).then(j=>j?.article?.text_content??null).catch(()=>null);
         fireCalls++;
         if(txt) fireText.set(sha256(r.link), txt);
       }));
     }
   
     /* 4 ───────── BUILD BULLETS & CITATIONS */
     const addBullet = (sec:string, txt:string, source:number)=>{
       const clean = trunc(txt.replace(/\s+/g,' ').trim(), BULLET_LEN);
       const sev = classify(clean);
       if(bulletsBy[sec].length < BULLET_CAP) bulletsBy[sec].push({ text: clean, source, sev });
     };
   
     targets.forEach((r, idx)=>{
       const body = fireText.get(sha256(r.link)) ?? r.snippet ?? r.title;
       const text = trunc(body.replace(/\s+/g," ").trim(), BULLET_LEN);
       const sev  = classify(text);
       const sec  =
         r.link.includes("github.com") || r.link.includes("pastebin") ? "Cyber" :
         r.link.match(/sec\.gov|10-k|10-q/i) ? "Legal" :
         sev === "CRITICAL" || sev === "HIGH" ? "Cyber" :
         "Corporate";
       addBullet(sec, text, idx + 1);
   
       citations[idx] = {
         marker:`[${idx+1}]`,
         url:r.link,
         title:r.title,
         snippet:trunc(text, 250),
       };
     });
   
     /* 5 ───────── SECTION SUMMARIES */
     const sections: Section[] = [];
     for(const name of Object.keys(bulletsBy)){
       const bullets = bulletsBy[name];
       let summary: string;
       if(!bullets.length) summary = "NSTR";
       else{
         const crit = bullets.filter(b=>b.sev==="CRITICAL").length;
         const hi   = bullets.filter(b=>b.sev==="HIGH").length;
         const base = `${bullets.length} findings (${crit} CRITICAL, ${hi} HIGH).`;
         const ctx  = bullets.map(b=>b.text).join("\n");
         summary = await llm(
           `Write 1-3 sentences. Start with "${base}"  Do NOT invent facts.`,
           ctx, SECT_OUT_TOK,
         );
       }
       sections.push({ name, summary, bullets });
     }
   
     /* 6 ───────── EXECUTIVE SUMMARY */
     const allBullets = sections.flatMap(s=>s.bullets.map(b=>b.text)).join("\n");
     const execSum = await llm(
       "Write a 3-5 sentence executive summary grounded ONLY on the bullets below.",
       allBullets,
       EXEC_OUT_TOK,
     );
   
     /* cost estimate (serper & firecrawl rough) */
     const cost = {
       serper: serperCalls * 0.005,
       firecrawl: fireCalls * 0.001,
       proxycurl: curlCalls * 0.01,
       llm: parseFloat(usdSpent.toFixed(4)),
       total: 0,
     };
     cost.total = parseFloat((cost.serper + cost.firecrawl + cost.proxycurl + cost.llm).toFixed(4));
   
     /* 7 ───────── RETURN */
     return {
       company: company_name,
       domain,
       generated: new Date().toISOString(),
       summary: execSum,
       sections,
       citations,
       cost,
     };
   }
   