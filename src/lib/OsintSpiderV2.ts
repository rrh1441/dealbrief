/* ──────────────────────────────────────────────────────────────────────────
   OSINT-Spider-V2  (2025-05-26)
   • Serper ≤ 600   • Firecrawl ≤ 200   • ProxyCurl ≤ 10
   • GPT-4.1-mini summaries, $2 cap
   • 6 sections, ≤ 50 bullets/section, 500 chars each
   • HARD FILTER: every accepted result, snippet, bullet must
     mention either the canonical company name or the domain.
   ------------------------------------------------------------------------ */

   import { createHash } from "node:crypto";
   import { performance } from "node:perf_hooks";
   import fetch from "node-fetch";
   import { z } from "zod";
   import natural from "natural";
   import OpenAI from "openai";
   
   export const runtime = "nodejs";
   
   /*────────────────────────────  ENV  ──────────────────────────────────────*/
   const { SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY } = process.env;
   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY)
     throw new Error("Missing SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY or OPENAI_API_KEY");
   
   /*────────────────────────────  CONSTANTS  ────────────────────────────────*/
   const SERPER  = "https://google.serper.dev/search";
   const FIRE    = "https://api.firecrawl.dev/v1/scrape";
   const CURL_P  = "https://nubela.co/proxycurl/api/v2/linkedin";
   const CURL_C  = "https://nubela.co/proxycurl/api/linkedin/company";
   
   const MAX_SERPER = 600, MAX_SERP_PAGE = 10, MAX_FIRECRAWL = 200, MAX_CURL = 10;
   const BATCH_FIRE = 20, FIRE_TIMEOUT_MS = 6_000, WALL_MS = 12 * 60_000;
   
   const MODEL_ID = "gpt-4.1-mini-2025-04-14", USD_CAP = 2.0;
   
   /* output sizes */
   const SECTIONS = ["Corporate","Legal","Cyber","Reputation","Leadership","Misc"] as const;
   const BULLET_CAP = 50, BULLET_LEN = 500;
   const EXEC_OUT_TOK = 300, SECT_OUT_TOK = 160;
   
   /*────────────────────────────  TYPES  ────────────────────────────────────*/
   type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
   interface Bullet   { text:string; source:number; sev:Sev }
   interface Section  { name:string; summary:string; bullets:Bullet[] }
   interface Citation { marker:string; url:string; title:string; snippet:string }
   
   export interface SpiderPayload {
     company:   string;
     domain:    string;
     generated: string;
     summary:   string;
     sections:  Section[];
     citations: Citation[];
     cost:      { serper:number; firecrawl:number; proxycurl:number; llm:number; total:number };
   }
   
   /*────────────────────────────  INPUT  ────────────────────────────────────*/
   const schema = z.object({
     company_name: z.string().trim().min(1),
     domain:       z.string().trim().min(3),
     owner_names:  z.array(z.string().trim()).optional(),
   });
   
   /*────────────────────────────  UTILITIES  ────────────────────────────────*/
   const sha256 = (s:string)=>createHash("sha256").update(s).digest("hex");
   const trunc  =(s:string,n:number)=>s.length<=n?s:s.slice(0,n-1)+"…";
   const tokens =(s:string)=>Math.ceil(s.length/3.5);
   const price  =(inTok:number,outTok:number)=>inTok*0.0004 + outTok*0.0016;
   
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   let usdSpent = 0;
   
   async function llm(prompt:string,ctx:string,outTok:number){
     const inTok=tokens(prompt)+tokens(ctx), est=price(inTok,outTok);
     if(usdSpent+est>USD_CAP) return "NSTR";
     const r = await ai.chat.completions.create({
       model: MODEL_ID, temperature: 0.25, max_tokens: outTok,
       messages:[{role:"system",content:prompt},{role:"user",content:ctx}],
     });
     usdSpent += price(inTok, r.usage?.completion_tokens ?? outTok);
     return r.choices[0].message.content!.trim();
   }
   
   async function postJSON<T>(url:string,body:unknown,hdr:Record<string,string>){
     const r = await fetch(url,{method:"POST",headers:{...hdr,"Content-Type":"application/json"},body:JSON.stringify(body)});
     if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
     return r.json() as Promise<T>;
   }
   
   /*────────────────────────────  REGEX / CLASSIFY  ─────────────────────────*/
   const RE_EMAIL  = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
   const RE_PHONE  = /\b\+?\d[\d\s().-]{6,}\d\b/g;
   const RE_SECRET = /\b(api[_-]?key|token|secret|password|authorization)\b/i;
   const RE_PDFXLS = /\.(pdf|xlsx)$/i;
   
   const classify=(s:string):Sev=>{
     const t=s.toLowerCase();
     if(t.match(RE_SECRET)) return "CRITICAL";
     if(t.match(/breach|leak|lawsuit|fraud|ransomware|invoice|pii/)) return "HIGH";
     if(t.match(/index of/)||RE_PDFXLS.test(t)) return "MEDIUM";
     return "LOW";
   };
   
   const jaccard=(a:string,b:string)=>{
     const A=new Set(a.toLowerCase().split(/\W+/)),B=new Set(b.toLowerCase().split(/\W+/));
     const inter=[...A].filter(x=>B.has(x)).length;
     return inter/(A.size+B.size-inter);
   };
   
   /*────────────────────────────  MAIN  ─────────────────────────────────────*/
   export async function runSpider(raw:unknown):Promise<SpiderPayload>{
     const start = performance.now();
     const { company_name, domain, owner_names=[] } = schema.parse(raw);
     const canon = company_name.toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
       .replace(/[.,']/g,"").trim();
   
     /* storage */
     const bullets: Record<typeof SECTIONS[number],Bullet[]> =
       Object.fromEntries(SECTIONS.map(s=>[s,[]])) as any;
     const citations: Citation[] = [];
     const hostCount:Record<string,number> = {};
     const stemSeen = new Set<string>();
   
     /* stats */
     let serperCalls=0, fireCalls=0, curlCalls=0;
   
     /* dork queue */
     const qBase = [
       `("${canon}" OR "${domain}") filetype:pdf`,
       `("${canon}" OR "${domain}") filetype:xlsx`,
       `("${canon}" OR "${domain}") site:*.gov`,
       `("@${domain}") site:github.com`,
       `"${canon}"`,
       `"${canon}" site:${domain}`,
       `("${canon}" OR "${domain}") ("breach" OR "leak" OR "lawsuit")`,
     ];
     owner_names.forEach(o=>qBase.push(`"${o}" ("${canon}" OR "${domain}")`));
     const queue:string[]=[...qBase], seenQ=new Set(queue);
     const seenUrl = new Set<string>();
     interface Hit{title:string;link:string;snippet?:string;score:number}
     const hits:Hit[]=[];
   
     /*───────────────── SERPER BFS ─────────────────*/
     while(queue.length&&serperCalls<MAX_SERPER&&performance.now()-start<WALL_MS){
       const q=queue.shift()!;
       const res=await postJSON<{organic?:any[]}>(SERPER,{q,num:MAX_SERP_PAGE,gl:"us",hl:"en"},
         {"X-API-KEY":SERPER_KEY!}).catch(()=>({}));
       serperCalls++;
       for(const o of res.organic??[]){
         const url=o.link as string; if(!url) continue;
         const canUrl=url.replace(/(\?|#).*/,"");
         const content=(o.title+o.snippet).toLowerCase();
         if(!content.includes(canon)&&!content.includes(domain)) continue;      // relevance guard
         if(seenUrl.has(canUrl)) continue;
         seenUrl.add(canUrl);
         if(jaccard(o.title,o.snippet??"")>0.85) continue;                     // anti-tagline clone
         const sc= scoreSerp(o,domain)+(url.includes(domain)?0:0.2);
         hits.push({title:o.title,link:url,snippet:o.snippet,score:sc});
   
         /* host expansion */
         try{
           const host=new URL(url).hostname;
           if(!seenQ.has(host)){seenQ.add(host);queue.push(`("${canon}" OR "${domain}") site:${host}`);}
         }catch{/* */}
       }
     }
     hits.sort((a,b)=>b.score-a.score);
   
     /*───────────────── PROXYCURL ────────────────*/
     const liCo=hits.find(h=>h.link.includes("linkedin.com/company/"));
     if(liCo&&curlCalls<MAX_CURL){
       const r=await fetch(`${CURL_C}?url=${encodeURIComponent(liCo.link)}`,
         {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
       curlCalls++;
       if(r?.ok){
         const j=await r.json() as {industry?:string;founded_year?:number};
         hits.unshift({link:liCo.link,title:liCo.title,
           snippet:`${j.industry??""} ${j.founded_year??""}`.trim(),score:0.8});
       }
     }
     for(const owner of owner_names.slice(0,9)){
       if(curlCalls>=MAX_CURL) break;
       let prof=hits.find(h=>h.link.includes("linkedin.com/in/")&&h.title.toLowerCase().includes(owner.toLowerCase()));
       if(!prof){
         const r=await postJSON<{organic?:any[]}>(SERPER,
           {q:`"${owner}" "linkedin.com/in/"`,num:5,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!})
           .catch(()=>({}));
         serperCalls++; prof=r.organic?.[0];
         if(prof)hits.push({...prof,score:0.5});
       }
       if(prof){
         const r=await fetch(`${CURL_P}?linkedin_profile_url=${encodeURIComponent(prof.link)}`,
           {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
         curlCalls++;
         if(r?.ok){
           const j=await r.json() as {headline?:string};
           hits.unshift({link:prof.link,title:`${owner} – LinkedIn`,snippet:j.headline,score:0.7});
         }
       }
     }
   
     /*───────────────── FIRECRAWL ───────────────*/
     const targets=hits.slice(0,MAX_FIRECRAWL);
     const scraped=new Map<string,string>();
     for(let i=0;i<targets.length&&fireCalls<MAX_FIRECRAWL;i+=BATCH_FIRE){
       await Promise.all(targets.slice(i,i+BATCH_FIRE).map(async h=>{
         if(performance.now()-start>=WALL_MS) return;
         const txt=await Promise.race([
           postJSON<{article?:{text_content?:string}}>(
             FIRE,{url:h.link,depth:0},{Authorization:`Bearer ${FIRECRAWL_KEY!}`}),
           new Promise<null>((_,rej)=>setTimeout(()=>rej("TO"),FIRE_TIMEOUT_MS)),
         ]).then(j=>j?.article?.text_content||null).catch(()=>null);
         fireCalls++; if(txt) scraped.set(sha256(h.link),txt);
       }));
     }
   
     /*───────────────── BULLETS & CITES ─────────*/
     const stem=(s:string)=>s.split(/\W+/).map(w=>natural.PorterStemmer.stem(w)).join(" ");
     const addBullet=(sec:string,text:string,src:number)=>{
       if(bullets[sec].length>=BULLET_CAP) return;
       const sig=stem(text).slice(0,240);
       if(stemSeen.has(sig)) return;
       if(!text.toLowerCase().includes(canon)&&!text.toLowerCase().includes(domain)) return;
       stemSeen.add(sig);
       const host=new URL(citations[src-1].url).hostname;
       if((hostCount[host]=(hostCount[host]??0)+1)>6) return;
       bullets[sec].push({text,source:src,sev:classify(text)});
     };
   
     targets.forEach((h,idx)=>{
       const body=scraped.get(sha256(h.link))||h.snippet||h.title||"";
       const text=trunc(body.replace(/\s+/g," ").trim(),BULLET_LEN);
       citations[idx]={marker:`[${idx+1}]`,url:h.link,title:h.title,snippet:trunc(text,250)};
   
       const sec =
         h.link.includes("github.com")||h.link.includes("pastebin") ?"Cyber":
         h.link.match(/sec\.gov|10-k|10-q/i)                    ?"Legal":
         h.link.includes("linkedin.com")                        ?"Leadership":
         h.link.match(/twitter|facebook|nextdoor/i)             ?"Reputation":
         classify(text)==="CRITICAL"||classify(text)==="HIGH"   ?"Cyber":
         "Corporate";
       addBullet(sec,text,idx+1);
     });
   
     /*───────────────── SECTION SUMMARIES ───────*/
     const sections:Section[]=[];
     for(const name of SECTIONS){
       const bl=bullets[name];
       const summary = bl.length
         ? await llm(
             `${bl.length} findings (${bl.filter(b=>b.sev==="CRITICAL").length} CRITICAL, ${bl.filter(b=>b.sev==="HIGH").length} HIGH). Summarize in ≤3 sentences, no new facts.`,
             bl.map(b=>b.text).join("\n"),SECT_OUT_TOK)
         : "NSTR";
       sections.push({name,summary,bullets:bl});
     }
   
     /*───────────────── EXEC SUMMARY ────────────*/
     const exec = await llm(
       "Write a 3-5 sentence executive summary using ONLY the bullet list.",
       sections.flatMap(s=>s.bullets.map(b=>b.text)).join("\n"),
       EXEC_OUT_TOK,
     );
   
     /*───────────────── COST REPORT ─────────────*/
     const cost={serper:serperCalls*0.005,firecrawl:fireCalls*0.001,proxycurl:curlCalls*0.01,
                 llm:+usdSpent.toFixed(4),total:0};
     cost.total=+(cost.serper+cost.firecrawl+cost.proxycurl+cost.llm).toFixed(4);
   
     /*───────────────── RETURN ──────────────────*/
     return {
       company: company_name,
       domain,
       generated: new Date().toISOString(),
       summary: exec,
       sections,
       citations,
       cost,
     };
   }
   