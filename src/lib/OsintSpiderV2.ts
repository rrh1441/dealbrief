/* ──────────────────────────────────────────────────────────────────────────
   OSINT-Spider-V2  (dependency-free, 2025-05-26)
   ------------------------------------------------------------------------
   • Serper ≤600  • Firecrawl ≤200  • ProxyCurl ≤10
   • GPT-4.1-mini summaries ($2 cap)
   • 6 sections, ≤50 bullets/section, relevance filters
   ------------------------------------------------------------------------ */

   import { createHash } from "node:crypto";
   import { performance } from "node:perf_hooks";
   import fetch from "node-fetch";
   import { z } from "zod";
   import OpenAI from "openai";
   
   export const runtime = "nodejs";
   
   /*──────────────────  ENV  ──────────────────*/
   const { SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY } = process.env;
   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY)
     throw new Error("Missing SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY or OPENAI_API_KEY");
   
   /*──────────────────  CONSTANTS  ────────────*/
   const SERPER  = "https://google.serper.dev/search";
   const FIRE    = "https://api.firecrawl.dev/v1/scrape";
   const CURL_P  = "https://nubela.co/proxycurl/api/v2/linkedin";
   const CURL_C  = "https://nubela.co/proxycurl/api/linkedin/company";
   
   const MAX_SERPER=600, MAX_SERP_PAGE=10, MAX_FIRECRAWL=200, MAX_CURL=10;
   const BATCH_FIRE=20, FIRE_TIMEOUT=6_000, WALL_MS=12*60_000;
   
   const MODEL="gpt-4.1-mini-2025-04-14", USD_CAP=2;
   
   const SECTIONS = ["Corporate","Legal","Cyber","Reputation","Leadership","Misc"] as const;
   const BULLET_CAP=50, BULLET_LEN=500, EXEC_TOK=300, SECT_TOK=160;
   
   /*──────────────────  TYPES  ───────────────*/
   type Sev = "CRITICAL"|"HIGH"|"MEDIUM"|"LOW";
   interface Bullet{ text:string; source:number; sev:Sev }
   interface Section{ name:string; summary:string; bullets:Bullet[] }
   interface Citation{ marker:string; url:string; title:string; snippet:string }
   
   export interface SpiderPayload{
     company:string; domain:string; generated:string; summary:string;
     sections:Section[]; citations:Citation[];
     cost:{serper:number; firecrawl:number; proxycurl:number; llm:number; total:number}
   }
   
   /*──────────────────  INPUT  ───────────────*/
   const schema=z.object({
     company_name:z.string().trim().min(1),
     domain:z.string().trim().min(3),
     owner_names:z.array(z.string().trim()).optional(),
   });
   
   /*──────────────────  HELPERS  ─────────────*/
   const sha256=(s:string)=>createHash("sha256").update(s).digest("hex");
   const trunc=(s:string,n:number)=>s.length<=n?s:s.slice(0,n-1)+"…";
   const tokens=(s:string)=>Math.ceil(s.length/3.5);
   const price=(inT:number,outT:number)=>inT*0.0004+outT*0.0016;
   
   const ai=new OpenAI({apiKey:OPENAI_API_KEY!});
   let usdSpent=0;
   async function llm(prompt:string,ctx:string,max:number){
     const cost=price(tokens(prompt)+tokens(ctx),max);
     if(usdSpent+cost>USD_CAP) return "NSTR";
     const r=await ai.chat.completions.create({
       model:MODEL,temperature:0.25,max_tokens:max,
       messages:[{role:"system",content:prompt},{role:"user",content:ctx}],
     });
     usdSpent+=price(tokens(prompt)+tokens(ctx),r.usage?.completion_tokens??max);
     return r.choices[0].message.content!.trim();
   }
   async function postJSON<T>(url:string,body:unknown,hdr:Record<string,string>){
     const r=await fetch(url,{method:"POST",headers:{...hdr,"Content-Type":"application/json"},body:JSON.stringify(body)});
     if(!r.ok) throw new Error(`${url} ${r.status}`);
     return r.json() as Promise<T>;
   }
   
   /* quick stem: lowercase, strip vowels, first 4 chars per word */
   const cheapStem=(s:string)=>s.toLowerCase().split(/\W+/).map(w=>w.replace(/[aeiou]/g,"").slice(0,4)).join("");
   
   /*──────────────────  REGEX / SCORE  ───────*/
   const RE_EMAIL=/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
   const RE_PHONE=/\b\+?\d[\d\s().-]{6,}\d\b/g;
   const RE_SECRET=/\b(api[_-]?key|token|secret|password|authorization)\b/i;
   const RE_PDFXLS=/\.(pdf|xlsx)$/i;
   
   const classify=(s:string):Sev=>{
     const t=s.toLowerCase();
     if(RE_SECRET.test(t)) return "CRITICAL";
     if(/breach|leak|lawsuit|fraud|ransomware|invoice|pii/.test(t)) return "HIGH";
     if(/index of/.test(t)||RE_PDFXLS.test(t)) return "MEDIUM";
     return "LOW";
   };
   const jaccard=(a:string,b:string)=>{
     const A=new Set(a.toLowerCase().split(/\W+/)),B=new Set(b.toLowerCase().split(/\W+/));
     const inter=[...A].filter(x=>B.has(x)).length;
     return inter/(A.size+B.size-inter);
   };
   const scoreSerp=(o:{link:string;title:string;snippet?:string},domain:string)=>{
     let s=0;
     if(o.link.includes(domain)) s+=0.3;
     if(RE_EMAIL.test(o.snippet??"")||RE_PHONE.test(o.snippet??"")) s+=0.2;
     if(/\.gov|\.edu|\.mil/.test(o.link)||RE_PDFXLS.test(o.link)) s+=0.2;
     if(/invoice|contract|apikey|secret|password/.test(o.snippet??"")) s+=0.2;
     if(/index of|error/i.test(o.title)) s+=0.1;
     return s;
   };
   
   /*──────────────────  MAIN  ────────────────*/
   export async function runSpider(raw:unknown):Promise<SpiderPayload>{
     const t0=performance.now();
     const {company_name,domain,owner_names=[]}=schema.parse(raw);
     const canon=company_name.toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
       .replace(/[.,']/g,"").trim();
   
     /* containers */
     const bullets:Record<string,Bullet[]> = Object.fromEntries(SECTIONS.map(s=>[s,[]])) as any;
     const citations:Citation[]=[];
     const hostHits:Record<string,number>={};
     const stemSeen=new Set<string>();
   
     /* stats */
     let serper=0,fire=0,curl=0;
   
     /* dork queue */
     const queue=[
       `("${canon}" OR "${domain}") filetype:pdf`,
       `("${canon}" OR "${domain}") filetype:xlsx`,
       `("${canon}" OR "${domain}") site:*.gov`,
       `("@${domain}") site:github.com`,
       `"${canon}"`,
       `"${canon}" site:${domain}`,
       `("${canon}" OR "${domain}") ("breach" OR "leak" OR "lawsuit")`,
     ];
     owner_names.forEach(o=>queue.push(`"${o}" ("${canon}" OR "${domain}")`));
     const seenQ=new Set(queue), seenUrl=new Set<string>();
   
     interface Hit{title:string;link:string;snippet?:string;score:number}
     const hits:Hit[]=[];
   
     /*────────── SERPER BFS ──────────*/
     while(queue.length&&serper<MAX_SERPER&&performance.now()-t0<WALL_MS){
       const q=queue.shift()!;
       const res=await postJSON<{organic?:any[]}>(SERPER,{q,num:MAX_SERP_PAGE,gl:"us",hl:"en"},
         {"X-API-KEY":SERPER_KEY!}).catch(()=>({}));
       serper++;
       for(const o of res.organic??[]){
         const url=o.link as string;if(!url)continue;
         const canonUrl=url.replace(/(\?|#).*/,"");
         const combined=(o.title+o.snippet).toLowerCase();
         if(!combined.includes(canon)&&!combined.includes(domain))continue;
         if(seenUrl.has(canonUrl))continue;
         if(jaccard(o.title,o.snippet??"")>0.85)continue;
         seenUrl.add(canonUrl);
         hits.push({title:o.title,link:url,snippet:o.snippet,score:scoreSerp(o,domain)});
         /* host expansion */
         try{
           const host=new URL(url).hostname;
           if(!seenQ.has(host)){seenQ.add(host);queue.push(`("${canon}" OR "${domain}") site:${host}`);}
         }catch{}
       }
     }
     hits.sort((a,b)=>b.score-a.score);
   
     /*────────── PROXYCURL ───────────*/
     const liCo=hits.find(h=>h.link.includes("linkedin.com/company/"));
     if(liCo&&curl<MAX_CURL){
       const r=await fetch(`${CURL_C}?url=${encodeURIComponent(liCo.link)}`,
         {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
       curl++;
       if(r?.ok){
         const j=await r.json()as{industry?:string;founded_year?:number};
         hits.unshift({link:liCo.link,title:liCo.title,
           snippet:`${j.industry??""} ${j.founded_year??""}`.trim(),score:0.8});
       }
     }
     for(const name of owner_names.slice(0,9)){
       if(curl>=MAX_CURL) break;
       const serperRes=await postJSON<{organic?:any[]}>(SERPER,
         {q:`"${name}" "linkedin.com/in/"`,num:5,gl:"us",hl:"en"},
         {"X-API-KEY":SERPER_KEY!}).catch(()=>({}));
       serper++;
       const prof=serperRes.organic?.[0];
       if(!prof) continue;
       const r=await fetch(`${CURL_P}?linkedin_profile_url=${encodeURIComponent(prof.link)}`,
         {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
       curl++;
       const headline=r?.ok?(await r.json()as{headline?:string}).headline:"";
       hits.unshift({link:prof.link,title:`${name} – LinkedIn`,snippet:headline,score:0.7});
     }
   
     /*────────── FIRECRAWL ───────────*/
     const targets=hits.slice(0,MAX_FIRECRAWL);
     const scraped=new Map<string,string>();
     for(let i=0;i<targets.length&&fire<MAX_FIRECRAWL;i+=BATCH_FIRE){
       await Promise.all(targets.slice(i,i+BATCH_FIRE).map(async h=>{
         if(performance.now()-t0>=WALL_MS) return;
         const txt=await Promise.race([
           postJSON<{article?:{text_content?:string}}>(FIRE,{url:h.link,depth:0},
             {Authorization:`Bearer ${FIRECRAWL_KEY!}`}),
           new Promise<null>((_,rej)=>setTimeout(()=>rej("TO"),FIRE_TIMEOUT)),
         ]).then(j=>j?.article?.text_content||null).catch(()=>null);
         fire++; if(txt) scraped.set(sha256(h.link),txt);
       }));
     }
   
     /*────────── BULLETS / CITES ─────*/
     const add=(sec:string,txt:string,src:number)=>{
       if(bullets[sec].length>=BULLET_CAP) return;
       if(!txt.toLowerCase().includes(canon)&&!txt.toLowerCase().includes(domain)) return;
       const sig=cheapStem(txt).slice(0,240);
       if(stemSeen.has(sig)) return;
       stemSeen.add(sig);
       const host=new URL(citations[src-1].url).hostname;
       if((hostHits[host]=(hostHits[host]??0)+1)>6) return;
       bullets[sec].push({text:txt,source:src,sev:classify(txt)});
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
       add(sec,text,idx+1);
     });
   
     /*────────── SECTION SUMS ─────────*/
     const sections:Section[] = SECTIONS.map(name=>{
       const bl=bullets[name];
       const summary = bl.length
         ? llm(
             `${bl.length} findings (${bl.filter(b=>b.sev==="CRITICAL").length} CRITICAL, ${bl.filter(b=>b.sev==="HIGH").length} HIGH). Summarize in ≤3 sentences; no new facts.`,
             bl.map(b=>b.text).join("\n"),SECT_TOK)
         : "NSTR";
       return {name,summary:typeof summary==="string"?summary:summary as unknown as string,bullets:bl};
     });
   
     /*────────── EXEC SUMMARY ─────────*/
     const exec=await llm(
       "Write a 3-5 sentence executive summary using ONLY the bullet list.",
       sections.flatMap(s=>s.bullets.map(b=>b.text)).join("\n"),EXEC_TOK);
   
     /*────────── COSTS ───────────────*/
     const cost={serper:serper*0.005,firecrawl:fire*0.001,proxycurl:curl*0.01,llm:+usdSpent.toFixed(4),total:0};
     cost.total=+(cost.serper+cost.firecrawl+cost.proxycurl+cost.llm).toFixed(4);
   
     return {company:company_name,domain,generated:new Date().toISOString(),summary:exec,sections,citations,cost};
   }   