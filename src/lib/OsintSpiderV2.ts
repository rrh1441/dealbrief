/*  OSINT-Spider-V2  –  2025-05-27
    -----------------------------------------------------------------------
    Web-only due diligence
      • Serper ≤600    • Firecrawl ≤200   • ProxyCurl ≤10
      • GPT-4.1-mini for summaries (no hard cost cap)
      • 6 sections, ≤50 bullets each
      • Strict TypeScript, zero implicit any
*/

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import fetch from "node-fetch";
import { z } from "zod";
import OpenAI from "openai";

export const runtime = "nodejs";

/*────────────────────────── ENV ──────────────────────────*/
const {
  SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY,
} = process.env;
if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY)
  throw new Error("Missing SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY or OPENAI_API_KEY");

/*──────────────────────── CONSTANTS ──────────────────────*/
const SERPER  = "https://google.serper.dev/search";
const FIRE    = "https://api.firecrawl.dev/v1/scrape";
const CURL_P  = "https://nubela.co/proxycurl/api/v2/linkedin";
const CURL_C  = "https://nubela.co/proxycurl/api/linkedin/company";

const MAX_SERPER   = 600;
const MAX_SERP_PAGE= 10;
const MAX_FIRE     = 200;
const MAX_CURL     = 10;
const BATCH_FIRE   = 20;
const FIRE_TIMEOUT = 6_000;
const WALL_MS      = 12 * 60_000;

const MODEL        = "gpt-4.1-mini-2025-04-14";

const SECTIONS = ["Corporate","Legal","Cyber","Reputation","Leadership","Misc"] as const;
type SectionName = typeof SECTIONS[number];

const BULLET_CAP  = 50;
const BULLET_LEN  = 500;
const EXEC_TOK    = 300;
const SECT_TOK    = 160;

/*──────────────────────── TYPES ──────────────────────────*/
type Sev = "CRITICAL"|"HIGH"|"MEDIUM"|"LOW";
interface Bullet   { text:string; source:number; sev:Sev }
interface Section  { name:SectionName; summary:string; bullets:Bullet[] }
interface Citation { marker:string; url:string; title:string; snippet:string }

interface SerperOrganic { title:string; link:string; snippet?:string }
interface SerperResp    { organic?:SerperOrganic[] }

interface FirecrawlResp { article?:{ text_content?:string } }

interface ProxyCurlProfile { headline?:string }
interface ProxyCurlCompany { industry?:string; founded_year?:number }

export interface SpiderPayload{
  company:string; domain:string; generated:string;
  summary:string; sections:Section[]; citations:Citation[];
  cost:{ serper:number; firecrawl:number; proxycurl:number; llm:number; total:number };
}

/*────────────────────── INPUT SCHEMA ───────────────────*/
const schema = z.object({
  company_name: z.string().trim().min(1),
  domain:       z.string().trim().min(3),
  owner_names:  z.array(z.string().trim()).optional(),
});

/*──────────────────────── HELPERS ───────────────────────*/
const sha256 = (s:string)=>createHash("sha256").update(s).digest("hex");
const trunc  = (s:string,n:number)=>s.length<=n?s:s.slice(0,n-1)+"…";
const tokens = (s:string)=>Math.ceil(s.length/3.5);
const price  = (inT:number,outT:number)=>inT*0.0004 + outT*0.0016;

/* cheap “stem” */
const cheapStem = (s:string)=>
  s.toLowerCase().split(/\W+/).map(w=>w.replace(/[aeiou]/g,"").slice(0,4)).join("");

/* LLM wrapper (no suppression) */
const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
let usdSpent = 0;
async function llm(prompt:string, ctx:string, maxTokens:number):Promise<string>{
  const result = await ai.chat.completions.create({
    model: MODEL, temperature: 0.25, max_tokens: maxTokens,
    messages:[{role:"system",content:prompt},{role:"user",content:ctx}],
  });
  usdSpent += price(tokens(prompt)+tokens(ctx), result.usage?.completion_tokens ?? maxTokens);
  return result.choices[0].message.content!.trim();
}

async function postJSON<T>(url:string, body:unknown, hdr:Record<string,string>):Promise<T>{
  const res = await fetch(url,{method:"POST",headers:{...hdr,"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

/*──────────────────────── REGEX & SCORE ────────────────*/
const RE_EMAIL  = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const RE_PHONE  = /\b\+?\d[\d\s().-]{6,}\d\b/g;
const RE_SECRET = /\b(api[_-]?key|token|secret|password|authorization|bearer)\b/i;
const RE_PDFXLS = /\.(pdf|xlsx)$/i;
const RISK_WORDS = /breach|leak|ransom|hack|apikey|secret|password|lawsuit|contract|invoice|pii/i;

const classify=(s:string):Sev=>{
  const t=s.toLowerCase();
  if(RE_SECRET.test(t)) return "CRITICAL";
  if(RISK_WORDS.test(t)) return "HIGH";
  if(/index of/.test(t)||RE_PDFXLS.test(t)) return "MEDIUM";
  return "LOW";
};

const jaccard=(a:string,b:string)=>{
  const A=new Set(a.toLowerCase().split(/\W+/));
  const B=new Set(b.toLowerCase().split(/\W+/));
  const inter=[...A].filter(x=>B.has(x)).length;
  return inter/(A.size+B.size-inter);
};

const scoreSerp=(o:SerperOrganic,domain:string)=>{
  let s=0;
  if(o.link.includes(domain)) s+=0.3;
  if(RE_EMAIL.test(o.snippet??"")||RE_PHONE.test(o.snippet??"")) s+=0.2;
  if(/\.(gov|edu|mil)/.test(o.link)||RE_PDFXLS.test(o.link))    s+=0.2;
  if(RISK_WORDS.test(o.snippet??""))                           s+=0.2;
  if(/index of|error/i.test(o.title)) s+=0.1;
  return s;
};

/*──────────────────────── MAIN ─────────────────────────*/
export async function runSpider(raw:unknown):Promise<SpiderPayload>{
  const t0 = performance.now();
  const { company_name, domain, owner_names=[] } = schema.parse(raw);

  const canon = company_name.toLowerCase()
    .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
    .replace(/[.,']/g,"").trim();

  /* containers */
  const bullets:Record<SectionName,Bullet[]>={
    Corporate:[],Legal:[],Cyber:[],Reputation:[],Leadership:[],Misc:[],
  };
  const citations:Citation[]=[];
  const stemSeen=new Set<string>();
  const hostCount:Record<string,number>={};

  /* stats */
  let serper=0, fire=0, curl=0;

  /*──── dork queue ────*/
  const qBase = (kw:string)=>`("${canon}" OR "${domain}") ${kw}`;
  const queue:string[]=[
    qBase("filetype:pdf"),
    qBase("filetype:xlsx"),
    qBase('site:*.gov'),
    `"@${domain}" site:github.com`,
    `"${canon}"`,
    `"${canon}" site:${domain}`,
    qBase('("breach" OR "leak" OR "ransom")'),
    qBase('("password" OR "apikey" OR "secret")'),
  ];
  owner_names.forEach(o=>queue.push(`"${o}" ("${canon}" OR "${domain}")`));
  const seenQ = new Set(queue);
  const seenUrl = new Set<string>();

  interface Hit{title:string;link:string;snippet?:string;score:number}
  const hits:Hit[]=[];

  /*──────── SERPER BFS ───────*/
  while(queue.length && serper<MAX_SERPER && performance.now()-t0<WALL_MS){
    const q = queue.shift()!;
    const sr = await postJSON<SerperResp>(
      SERPER,{q,num:MAX_SERP_PAGE,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!}).catch(()=>({organic:[]}));
    serper++;
    for(const o of sr.organic!){
      const url=o.link; if(!url) continue;
      const canonUrl=url.replace(/(\?|#).*/,"");
      if(seenUrl.has(canonUrl)) continue;

      const joined=(o.title+o.snippet).toLowerCase();
      if(!joined.includes(canon)&&!joined.includes(domain)) continue;
      if(jaccard(o.title,o.snippet??"")>0.85) continue;

      seenUrl.add(canonUrl);
      hits.push({title:o.title,link:url,snippet:o.snippet,score:scoreSerp(o,domain)});

      /* host expansion */
      try{
        const host=new URL(url).hostname;
        if(!seenQ.has(host)){ seenQ.add(host); queue.push(`("${canon}" OR "${domain}") site:${host}`); }
      }catch{/* ignore */}
    }
  }
  hits.sort((a,b)=>b.score-a.score);

  /*──────── ProxyCurl enrich ─────*/
  const liCo=hits.find(h=>h.link.includes("linkedin.com/company/"));
  if(liCo&&curl<MAX_CURL){
    const r=await fetch(`${CURL_C}?url=${encodeURIComponent(liCo.link)}`,
      {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
    curl++;
    if(r?.ok){
      const j=await r.json() as ProxyCurlCompany;
      hits.unshift({...liCo,snippet:`${j.industry??""} ${j.founded_year??""}`.trim(),score:0.8});
    }
  }
  for(const owner of owner_names.slice(0,9)){
    if(curl>=MAX_CURL) break;
    const sr=await postJSON<SerperResp>(SERPER,
      {q:`"${owner}" "linkedin.com/in/"`,num:5,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!}).catch(()=>({organic:[]}));
    serper++;
    const p=sr.organic![0]; if(!p) continue;
    const enrich=await fetch(`${CURL_P}?linkedin_profile_url=${encodeURIComponent(p.link)}`,
      {headers:{Authorization:`Bearer ${PROXYCURL_KEY!}`}}).catch(()=>null);
    curl++;
    const headline=enrich?.ok?(await enrich.json() as ProxyCurlProfile).headline:"";
    hits.unshift({title:`${owner} – LinkedIn`,link:p.link,snippet:headline,score:0.7});
  }

  /*──────── Firecrawl ───────*/
  const targets=hits.slice(0,MAX_FIRE);
  const scraped=new Map<string,string>();
  for(let i=0;i<targets.length&&fire<MAX_FIRE;i+=BATCH_FIRE){
    await Promise.all(targets.slice(i,i+BATCH_FIRE).map(async h=>{
      if(performance.now()-t0>=WALL_MS) return;
      const txt=await Promise.race([
        postJSON<FirecrawlResp>(FIRE,{url:h.link,depth:0},
          {Authorization:`Bearer ${FIRECRAWL_KEY!}`}),
        new Promise<null>((_,rej)=>setTimeout(()=>rej("TO"),FIRE_TIMEOUT)),
      ]).then(r=>r?.article?.text_content??null).catch(()=>null);
      fire++; if(txt) scraped.set(sha256(h.link),txt);
    }));
  }

  /*──────── Bullet & Citations ─────────*/
  const addBullet=(sec:SectionName,text:string,src:number)=>{
    if(bullets[sec].length>=BULLET_CAP) return;
    if(!text.toLowerCase().includes(canon)&&!text.toLowerCase().includes(domain)) return;
    if(sec==="Cyber" && !RISK_WORDS.test(text)) return;     // stricter Cyber gate
    const sig=cheapStem(text).slice(0,120);
    if(stemSeen.has(sig)) return;
    stemSeen.add(sig);
    const host=new URL(citations[src-1].url).hostname;
    if((hostCount[host]=(hostCount[host]??0)+1)>6) return;
    bullets[sec].push({text,source:src,sev:classify(text)});
  };

  targets.forEach((h,idx)=>{
    const body=scraped.get(sha256(h.link)) ?? h.snippet ?? h.title;
    const txt=trunc(body.replace(/\s+/g," ").trim(),BULLET_LEN);

    citations[idx]={marker:`[${idx+1}]`,url:h.link,title:h.title,snippet:trunc(txt,250)};

    let sec:SectionName="Corporate";
    if(h.link.includes("github.com")||h.link.includes("pastebin")) sec="Cyber";
    else if(/sec\.gov|10-q|10-k/i.test(h.link))                   sec="Legal";
    else if(h.link.includes("linkedin.com"))                      sec="Leadership";
    else if(/twitter|facebook|nextdoor/.test(h.link))             sec="Reputation";
    else if(classify(txt)==="CRITICAL"||classify(txt)==="HIGH")   sec="Cyber";
    addBullet(sec,txt,idx+1);
  });

  /*──────── Section summaries ─────────*/
  const sections:Section[] = await Promise.all(SECTIONS.map(async name=>{
    const bl=bullets[name];
    if(!bl.length) return {name,summary:"NSTR",bullets:bl};
    const c=bl.filter(b=>b.sev==="CRITICAL").length;
    const h=bl.filter(b=>b.sev==="HIGH").length;
    return {
      name,
      summary:await llm(
        `${bl.length} findings (${c} CRITICAL, ${h} HIGH). Summarize in ≤3 sentences; no new facts.`,
        bl.map(b=>b.text).join("\n"),SECT_TOK),
      bullets:bl,
    };
  }));

  /*──────── Executive summary ─────────*/
  const exec = await llm(
    "Write a 3-5 sentence executive summary using ONLY the bullet list.",
    sections.flatMap(s=>s.bullets.map(b=>b.text)).join("\n"),EXEC_TOK);

  /*──────── Cost ──────────────────────*/
  const cost={
    serper: serper * 0.005,
    firecrawl: fire * 0.001,
    proxycurl: curl * 0.01,
    llm: +usdSpent.toFixed(4),
    total: 0,
  };
  cost.total = +(cost.serper + cost.firecrawl + cost.proxycurl + cost.llm).toFixed(4);

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
