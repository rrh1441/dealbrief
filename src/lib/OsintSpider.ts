/* ──────────────────────────────────────────────────────────────────────────
   src/lib/OsintSpider.ts  · 2025-05-27
   --------------------------------------------------------------------------
   Web-only due-diligence spider — Serper → Firecrawl → ProxyCurl → LLM.

   Key behaviour (unchanged):
     • Permanent-failure detection for Firecrawl (408/500/502/ERR_TUNNEL…)
     • Skip-and-flag pages lacking article.text_content
     • ProxyCurl enrichment (company + owners)
   ------------------------------------------------------------------------ */

   import { performance } from "node:perf_hooks";
   import fetch, { Response as FetchResponse, RequestInit } from "node-fetch";
   import { z } from "zod";
   import OpenAI from "openai";
   
   /*────────────────────────── ENV ──────────────────────────*/
   let SERPER_KEY: string;
   let FIRECRAWL_KEY: string;
   let PROXYCURL_KEY: string;
   let OPENAI_API_KEY: string;

   try {
     const env = process.env;
     SERPER_KEY = env.SERPER_KEY!;
     FIRECRAWL_KEY = env.FIRECRAWL_KEY!;
     PROXYCURL_KEY = env.PROXYCURL_KEY!;
     OPENAI_API_KEY = env.OPENAI_API_KEY!;
   
     if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
       throw new Error(
         "CRITICAL ERROR: Missing one or more API keys (SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY)."
       );
     }
   } catch (err) {
     console.error("Fatal initialisation error:", err);
     throw err;          // still let the function fail with 500
   }
   
   /*──────────────────────── CONSTANTS ──────────────────────*/
   const SERPER_API_URL               = "https://google.serper.dev/search";
   const FIRECRAWL_API_URL            = "https://api.firecrawl.dev/v1/scrape";
   const PROXYCURL_API_COMPANY_URL    = "https://nubela.co/proxycurl/api/linkedin/company";
   const PROXYCURL_API_PROFILE_URL    = "https://nubela.co/proxycurl/api/v2/linkedin";
   
   const MAX_SERPER_CALLS             = 600;
   const MAX_SERP_RESULTS_PER_PAGE    = 10;
   const MAX_FIRECRAWL_TARGETS        = 40;
   const MAX_PROXYCURL_CALLS          = 10;
   
   const FIRECRAWL_GLOBAL_BUDGET_MS   = 360_000;   // 6 min (compromise)
   const MAX_WALL_TIME_MS             = 600_000;   // 10 min (under your 720s limit)
   
   const LLM_MODEL_INSIGHT_EXTRACTION = "gpt-4o-mini";
   const LLM_MODEL_FILE_PREDICTION    = "gpt-4o-mini";
   const LLM_MODEL_SUMMARIZATION      = "gpt-4o-mini";
   
   const MAX_BULLETS_PER_SECTION                = 50;
   const MAX_BULLET_LENGTH                      = 500;
   const MAX_TOKENS_EXEC_SUMMARY                = 300;
   const MAX_TOKENS_SECTION_SUMMARY             = 160;
   const MAX_TOKENS_FOR_INSIGHT_EXTRACTION_IN   = 7000;
   const MAX_TOKENS_FOR_INSIGHT_EXTRACTION_OUT  = 1000;
   const MAX_TOKENS_FOR_FILE_PREDICTION_OUT     = 150;
   const MAX_SOURCES_TO_LLM                     = 30;
   
   const SECTIONS = [
     "Corporate",
     "Legal",
     "Cyber",
     "Reputation",
     "Leadership",
     "Financials",
     "Misc",
   ] as const;
   type SectionName = (typeof SECTIONS)[number];
   
   /*──────────────────────── TYPES ──────────────────────────*/
   type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
   
   interface ExtractedInsight {
     insightStatement   : string;
     supportingQuote?   : string;
     categorySuggestion : SectionName;
     severitySuggestion : Severity;
     sourceUrl          : string;
     citationMarker?    : string;
   }
   
   export interface ReportBullet {
     text              : string;
     quote?            : string;
     sourceUrl         : string;
     citationMarker    : string;
     severity          : Severity;
     origin            : "llm_insight" | "heuristic_snippet" | "file_placeholder" | "proxycurl_summary";
     llmSuggestedCategory?: SectionName;
   }
   
   export interface SectionOutput {
     name    : SectionName;
     summary : string;
     bullets : ReportBullet[];
   }
   
   export interface Citation {
     marker  : string;
     url     : string;
     title   : string;
     snippet : string;
   }
   
   interface SerperOrganicResult {
     title   : string;
     link    : string;
     snippet?: string;
     position?: number;
   }
   interface SerperResponse { organic?: SerperOrganicResult[] }
   
   interface FirecrawlScrapeV1Result {
     success: boolean;
     data?  : {
       content      : string;
       markdown     : string;
       text_content : string;
       metadata     : Record<string,string|number|boolean|undefined|null>;
       article?: { text_content?: string };
     };
     error? : string;
     status?: number;
   }
   
   interface YearMonthDay { year?: number; month?: number; day?: number }
   interface LinkedInExperience {
     company?   : string; title?   : string;
     starts_at? : YearMonthDay; ends_at?: YearMonthDay; description?: string;
   }
   interface ProxyCurlCommon {
     linkedin_profile_url?         : string;
     linkedin_company_profile_url? : string;
     [k: string]: unknown;
   }
   interface ProxyCurlProfileResult extends ProxyCurlCommon {
     public_identifier?: string; profile_pic_url?: string; background_cover_image_url?: string;
     first_name?: string; last_name?: string; full_name?: string;
     occupation?: string; headline?: string; summary?: string;
     country_full_name?: string; city?: string; state?: string;
     experiences?: LinkedInExperience[];
   }
   interface ProxyCurlCompanyResult extends ProxyCurlCommon {
     name?: string; description?: string; industry?: string;
     founded_year?: number; company_size_on_linkedin?: number;
     website?: string; tagline?: string;
     headquarters?: { city: string; state: string; country: string };
   }
   
   export interface FileForManualReview {
     url            : string;
     title          : string;
     serpSnippet    : string;
     predictedInterest : string;
     citationMarker : string;
   }
   
   export interface OsintSpiderPayload {
     company              : string;
     domain               : string;
     generated            : string;
     summary              : string;
     sections             : SectionOutput[];
     citations            : Citation[];
     filesForManualReview : FileForManualReview[];
     cost : { serper:number; firecrawl:number; proxycurl:number; llm:number; total:number };
     stats: {
       serperQueries : number; serperResultsProcessed : number;
       firecrawlTargets : number; firecrawlAttempts : number; firecrawlSuccesses : number;
       pagesForDeepAnalysis : number;
       llmInsightExtractionCalls : number; llmSummarizationCalls : number; llmFilePredictionCalls : number;
       totalLlmInputTokens : number; totalLlmOutputTokens : number;
       proxycurlCalls : number; wallTimeSeconds : number;
     };
   }
   
   /*────────────────────── INPUT SCHEMA ───────────────────*/
   const osintSpiderInputSchema = z.object({
     company_name: z.string().trim().min(1),
     domain      : z.string().trim().min(3).refine(v => /\./.test(v)),
     owner_names : z.array(z.string().trim().min(1)).optional(),
   });
   
   /*──────────────────────── HELPERS ───────────────────────*/
   const truncateText  = (s:string,n:number) => (s||"").length<=n ? s||"" : (s||"").slice(0,n-1)+"…";
   const estimateTokens = (s:string) => Math.ceil((s||"").length / 3.5);
   
   const INPUT_TOKEN_PRICE_PER_M  = 0.15;
   const OUTPUT_TOKEN_PRICE_PER_M = 0.60;
   const calcLlmCost = (inTok:number,outTok:number) =>
     inTok/1e6*INPUT_TOKEN_PRICE_PER_M + outTok/1e6*OUTPUT_TOKEN_PRICE_PER_M;
   
   /*────────────────────────── REGEX ───────────────────────*/
   const RISK_WORDS_OS = /\b(breach|leak|ransom|hack|exposed data|vulnerability|security incident|cyberattack|fraud|scandal|lawsuit|litigation|complaint|sec filing|investigation|fine|penalty|illegal|unethical|corruption|bribery|money laundering|sanction|recall|unsafe|defect|warning letter|regulatory action|insolvency|bankruptcy|default|liquidation|receivership|cease and desist)\b/i;
   const FILE_EXT_REGEX = /\.(pdf|xlsx?|docx?|csv|txt|log|sql|bak|zip|tar\.gz|tgz)$/i;
   
   /*──────────────────────── LLM SETUP ─────────────────────*/
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   let totalLlmIn = 0, totalLlmOut = 0;
   let llmInsightCalls = 0, llmSummaryCalls = 0, llmFileCalls = 0;
   
   async function callLlm(
     prompt:string, system:string, model:string,
     maxOut:number, temperature=0.2,
   ):Promise<string|null>{
     totalLlmIn += estimateTokens(prompt)+estimateTokens(system);
     try{
       const r = await ai.chat.completions.create({
         model,
         messages:[{role:"system",content:system},{role:"user",content:prompt}],
         temperature, max_tokens:maxOut,
       });
       const txt=r.choices[0]?.message?.content||"";
       totalLlmOut += r.usage?.completion_tokens ?? estimateTokens(txt);
       return txt.trim();
     }catch(e:unknown){
       const err = e as Error;
       console.error("[LLM] error",err.message);
       return null;
     }
   }
   
   /*─────────────────── HTTP HELPER ───────────────────────*/
   async function postJSON<T>(
     url:string, body:unknown, headers:Record<string,string>,
     method:"POST"|"GET"="POST",
   ):Promise<T>{
     const opt:RequestInit={method,headers:{...headers,"Content-Type":"application/json"}};
     if(method==="POST") opt.body = JSON.stringify(body);
     const resp:FetchResponse = await fetch(url,opt);
     if(!resp.ok){
       const txt = await resp.text();
       throw new Error(`HTTP ${resp.status} from ${url}: ${truncateText(txt,120)}`);
     }
     return resp.json() as Promise<T>;
   }
   
   /*──────────────── FIRECRAWL ───────────────────────────*/
   const FIRECRAWL_BLACKLIST = new Set([
     "linkedin.com","www.linkedin.com","facebook.com","www.facebook.com","m.facebook.com",
     "instagram.com","www.instagram.com","twitter.com","x.com","www.twitter.com","www.x.com",
     "tiktok.com","www.tiktok.com","reddit.com","www.reddit.com","old.reddit.com",
     "googleusercontent.com","wsj.com","www.wsj.com","ft.com","www.ft.com",
     "patreon.com","www.patreon.com","news.ycombinator.com","apps.dos.ny.gov",
     "yelp.com","www.yelp.com","m.yelp.com","nextdoor.com","www.nextdoor.com",
   ]);
   
   let firecrawlAttempts=0, firecrawlSuccesses=0;
   const dynamicNoScrape = new Set<string>();
   
   /** marker returned when Firecrawl has no article.text_content */
   const FIRECRAWL_SKIPPED = "__FIRECRAWL_SKIPPED__";
   
   const permanentFail = (status?:number,msg?:string)=>
     !!(status && [408,500,502].includes(status) || msg && /ERR_TUNNEL_CONNECTION_FAILED/i.test(msg));
   
   async function firecrawlWithLogging(
     url:string, tag:string
   ):Promise<string|typeof FIRECRAWL_SKIPPED|null>{
     const host=(()=>{try{return new URL(url).hostname.replace(/^www\./,"");}catch{ return""; }})();
     if(host && (FIRECRAWL_BLACKLIST.has(host)||dynamicNoScrape.has(host))){
       console.log(`[Firecrawl Skip] ${url} host blacklisted`);
       return null;
     }
     firecrawlAttempts++;
     const attempt = async (timeout:number)=>{
       try{
         console.debug(`[Firecrawl] ${tag} ${timeout}ms`);
         const resp = await Promise.race([
           postJSON<FirecrawlScrapeV1Result>(
             FIRECRAWL_API_URL,{url},{Authorization:`Bearer ${FIRECRAWL_KEY!}`}),
           new Promise<never>((_,rej)=>setTimeout(()=>rej(new Error("Timeout")),timeout))
         ]);
         if(resp.success && resp.data?.article?.text_content?.trim()){
           firecrawlSuccesses++; return resp.data.article.text_content;
         }
         if(resp.success) return FIRECRAWL_SKIPPED;
         
         console.error(
           `[Firecrawl API Error] ${tag} — ${url} (status ${resp.status ?? "?"}): ${resp.error}`,
         );

         if (resp.error?.toLowerCase().includes("load failed")) {
           return FIRECRAWL_SKIPPED;          // treat like 'no article text'
         }

         if(permanentFail(resp.status,resp.error) && host) {
           dynamicNoScrape.add(host);
           console.warn(`[Firecrawl PermanentFailure] ${host} added to no-scrape list`);
         }
         return null;
       }catch(e:unknown){
         const err = e as Error;
         if(permanentFail(undefined,err.message) && host) dynamicNoScrape.add(host);
         return null;
       }
     };
     let out = await attempt(25_000);
     if(out===null) out=await attempt(40_000);
     return out;
   }
   
   /*──────────────── SERPER scoring & dorks ─────────────────*/
   const scoreSerpResultInitial = (
     r: SerperOrganicResult,
     domain: string,
     companyCanon: string,
     riskKeywords: string[] = [],
   ): number => {
     const phrase = companyCanon.toLowerCase();
     if (
       !(r.snippet || "").toLowerCase().includes(phrase) &&
       !(r.title   || "").toLowerCase().includes(phrase)
     ) {
       return 0;          // skip if phrase absent
     }
     let s=0.1;
     const snippet=(r.snippet||"").toLowerCase();
     const title  =(r.title  ||"").toLowerCase();
     if(r.link.includes(domain)) s+=0.2;
     if(riskKeywords.some(k=>snippet.includes(k)||title.includes(k))) s+=0.3;
     if(RISK_WORDS_OS.test(snippet)||RISK_WORDS_OS.test(title)) s+=0.25;
     if(r.link.match(FILE_EXT_REGEX)) s+=0.1;
     if(r.link.includes("sec.gov")||r.link.includes("courtlistener.com")||r.link.includes("justice.gov")) s+=0.2;
     if(r.link.includes("news.")||r.link.includes("/news")||r.link.includes("reuters.com")||r.link.includes("bloomberg.com")||r.link.includes("wsj.com")) s+=0.15;
     return Math.min(1,s);
   };
   
   const getTargetedDorksExpanded = (canon:string, domain:string, owners:string[]=[])=>
   /* full expanded dork list retained exactly as original (omitted here only in this comment) */
   {
     const dorks:{query:string,type:string,priority:number}[]=[];
     const companyPhrase = `"${canon}"`;                     // exact phrase
     const companyPhraseOrDomain = `(${companyPhrase} OR "${domain}")`;
     const push=(q:string,type:SectionName| "General",p:number)=>dorks.push({query:q,type,priority:p});
   
     /* --- legal / regulatory --- */
     ["lawsuit","litigation","court case","legal action","settlement","class action"].forEach(k=>
       push(`${companyPhraseOrDomain} ${k}`,"Legal",10));
     push(`${companyPhraseOrDomain} site:sec.gov "sec filing"`,"Financials",10);
     push(`${companyPhraseOrDomain} site:sec.gov "10-K"`,"Financials",10);
     push(`${companyPhraseOrDomain} site:sec.gov "10-Q"`,"Financials",10);
     ["fine","penalty","sanction","regulatory action","investigation"].forEach(k=>
       push(`${companyPhrase} ${k}`,"Legal",9));
   
     /* --- cyber / breaches --- */
     ['"data breach"','"cyber attack"','hacked','"vulnerability disclosed"','"security incident"','ransomware']
       .forEach(k=>push(`${companyPhraseOrDomain} ${k}`,"Cyber",10));
     ['"exposed database"','"leaked credentials"','"api key leak"']
       .forEach(k=>push(`${companyPhraseOrDomain} ${k}`,"Cyber",9));
     ["pastebin.com","ghostbin.com","plaintext.in"].forEach(site=>
       push(`site:${site} (${companyPhraseOrDomain})`,"Cyber",8));
     push(`site:github.com (${companyPhraseOrDomain}) password`,"Cyber",8);
     push(`site:github.com (${companyPhraseOrDomain}) secret`  ,"Cyber",8);
     push(`site:github.com (${companyPhraseOrDomain}) apikey`  ,"Cyber",8);
   
     /* --- reputation --- */
     ["scandal","controversy","fraud","misconduct","unethical","protest","boycott","\"consumer complaints\""]
       .forEach(k=>push(`${companyPhrase} ${k}`,"Reputation",9));
     push(`${companyPhrase} reviews complaint -site:${domain}`,"Reputation",8);
   
     /* --- corporate / financials --- */
     ['"acquisition of"','"merger with"','"acquired by"','"invested in"','"partnership with"','"joint venture"']
       .forEach(k=>push(`${companyPhrase} ${k}`,"Corporate",7));
     ['"financial results"','earnings','"annual report"','"investor relations"','"funding round"']
       .forEach(k=>push(`${companyPhrase} ${k}`,"Financials",7));
     ["layoffs","restructuring","chapter 11","bankruptcy","insolvency","store closures"]
       .forEach(k=>push(`${companyPhrase} ${k}`,"Corporate",8));
   
     /* simple fallbacks */
     push(`${companyPhrase}`,"Corporate",5);
     push(`${companyPhrase} site:${domain}`,"Corporate",4);
   
     owners.forEach(o=>{
       ["fraud","lawsuit","investigation","scandal","controversy","\"insider trading\""]
         .forEach(k=>push(`"${o}" ${companyPhrase} ${k}`,"Leadership",9));
       push(`"${o}" ${companyPhrase}`,"Leadership",6);
     });
     return dorks;
   };
   
   interface PrioritizedSerpResult extends SerperOrganicResult {
     initialScore: number; dorkType: string; priorityForScraping: number;
   }
   function selectTopScrapingTargets(
     hits:{hit:SerperOrganicResult,dorkType:string}[],
     _canon:string, domain:string, max:number,
   ):PrioritizedSerpResult[]{
     const riskKw = RISK_WORDS_OS.source.replace(/\\b/g,"").replace(/^\(|\)$/g,"").split("|").map(s=>s.toLowerCase());
     const scored:PrioritizedSerpResult[] = hits.map(({hit,dorkType})=>{
       let pr=1;
       const txt=(hit.snippet||"")+" "+(hit.title||"");
       if(RISK_WORDS_OS.test(txt)) pr+=5;
       if(["Legal","Cyber","Financials"].includes(dorkType)) pr+=3;
       if(hit.link.includes("sec.gov")||hit.link.includes("courtlistener.com")) pr+=4;
       if(hit.link.match(FILE_EXT_REGEX)) pr+=2;
       if(hit.link.includes("news.")||hit.link.includes("/news")) pr+=3;
       if(hit.link.includes(domain)&&!hit.link.match(/\/(blog|news|press)/)) pr-=2;
       const scoreInit=scoreSerpResultInitial(hit,domain,_canon,riskKw);
       return {...hit,initialScore:scoreInit,dorkType,priorityForScraping:pr+scoreInit*5};
     });
     scored.sort((a,b)=>b.priorityForScraping-a.priorityForScraping);
     const unique = Array.from(new Map(scored.map(i=>[i.link,i])).values());
     return unique.slice(0,max);
   }
   
   /*──────────────── INSIGHT-EXTRACTION ───────────────────*/
   async function extractInsightsFromPage(
     text:string, url:string, canon:string, domain:string, owners:string[]
   ):Promise<ExtractedInsight[]>{
     llmInsightCalls++;
     const prompt = `
   CONTEXT: Web page text from ${url}.
   Company analysed: "${canon}" (domain ${domain}). Owners/key personnel: ${owners.join(", ")||"N/A"}.
   
   TEXT:
   ${truncateText(text, MAX_TOKENS_FOR_INSIGHT_EXTRACTION_IN*3.5)}
   
   TASK:
   Extract up to 5 actionable due-diligence findings. Return a JSON array only.`;
     const raw = await callLlm(prompt,"You are an OSINT analyst.",
       LLM_MODEL_INSIGHT_EXTRACTION, MAX_TOKENS_FOR_INSIGHT_EXTRACTION_OUT,0.1);
     if(!raw) return [];
     try{
       const cleaned = raw.replace(/```(?:json)?/g,"").replace(/```/g,"").trim();
       const parsed = JSON.parse(cleaned) as Partial<ExtractedInsight>[];
       if(Array.isArray(parsed))
         return parsed.filter(p=>p.insightStatement).map(p=>({
           insightStatement : p.insightStatement!,
           supportingQuote  : p.supportingQuote,
           categorySuggestion : SECTIONS.includes(p.categorySuggestion as SectionName)
             ? p.categorySuggestion as SectionName : "Misc",
           severitySuggestion : ["CRITICAL","HIGH","MEDIUM","LOW","INFO"]
             .includes(p.severitySuggestion as Severity)
             ? p.severitySuggestion as Severity : "INFO",
           sourceUrl:url,
         }));
     }catch(e:unknown){ 
       const err = e as Error;
       console.error("[Parse insight] error",err); 
     }
     return [];
   }
   
   /*──────────────── FILE-interest predictor ──────────────*/
   async function predictFileInterest(
     url:string,title:string,snippet:string){
     llmFileCalls++;
     const prompt = `File URL: ${url}\nTitle:${title}\nSnippet:${snippet}\nDescribe potential due-diligence interest (short).`;
     return (await callLlm(prompt,"You are an analyst.",
       LLM_MODEL_FILE_PREDICTION, MAX_TOKENS_FOR_FILE_PREDICTION_OUT,0.3)) || "Unclear";
   }
   
   /*──────────────────────── MAIN FUNCTION ─────────────────────────*/
   export async function runOsintSpider(rawInput:unknown):Promise<OsintSpiderPayload>{
     console.log("[OsintSpider] Starting with input:", rawInput);
     const t0 = performance.now();
   
     /* reset global counters */
     totalLlmIn=totalLlmOut=0; firecrawlAttempts=firecrawlSuccesses=0;
     llmInsightCalls=llmSummaryCalls=llmFileCalls=0; dynamicNoScrape.clear();
   
     let proxycurlCalls=0;
   
     const { company_name, domain, owner_names=[] } =
       osintSpiderInputSchema.parse(rawInput);
     
     console.log("[OsintSpider] Parsed input - company:", company_name, "domain:", domain);
   
     const canon = company_name.toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
       .replace(/[.,']/g,"").trim();
   
     const bulletsBySection:Record<SectionName,ReportBullet[]> =
       SECTIONS.reduce((a,s)=>({...a,[s]:[]}),{} as Record<SectionName,ReportBullet[]>);
   
     const citations: Citation[] = [];
     const filesForManualReview: FileForManualReview[] = [];
     const processedUrls = new Set<string>();
   
     /* ensure vars declared before use (lint fixes) */
     let prioritizedScrapingTargets: PrioritizedSerpResult[] = [];
     const sectionsOutput: SectionOutput[] = [];
     let executiveSummary = "";
   
     /*──────────────── PHASE 1 — SERPER ────────────────*/
     const dorks = getTargetedDorksExpanded(canon,domain,owner_names)
       .sort((a,b)=>b.priority-a.priority);
     let serperQueries=0; const allSerpHits:{hit:SerperOrganicResult,dorkType:string}[]=[];
     for(const d of dorks){
       if(performance.now()-t0>MAX_WALL_TIME_MS*0.6 || serperQueries>=MAX_SERPER_CALLS) break;
       try{
         const r=await postJSON<SerperResponse>(
           SERPER_API_URL,{q:d.query,num:MAX_SERP_RESULTS_PER_PAGE,gl:"us",hl:"en"},
           {"X-API-KEY":SERPER_KEY!});
         serperQueries++;
         (r.organic||[]).forEach(h=>allSerpHits.push({hit:h,dorkType:d.type}));
       }catch(e:unknown){ 
         const err = e as Error;
         console.warn("[Serper] error",err); 
       }
     }
     const serperResultsProcessed = allSerpHits.length;
   
     /*──────────────── PHASE 1.5 — ProxyCurl enrichment ─────────────*/
     if(PROXYCURL_KEY){
       const companyLi = allSerpHits.find(h=>h.hit.link.includes("linkedin.com/company/"));
       if(companyLi && proxycurlCalls<MAX_PROXYCURL_CALLS){
         try{
           const data = await postJSON<ProxyCurlCompanyResult>(
             `${PROXYCURL_API_COMPANY_URL}?url=${encodeURIComponent(companyLi.hit.link)}&fallback_to_cache=on-error&use_cache=if-present`,
             {},{Authorization:`Bearer ${PROXYCURL_KEY!}`},"GET");
           proxycurlCalls++;
           if(data){
             const enriched = `${data.industry||"Industry N/A"}; Founded ${data.founded_year||"N/A"}. ${truncateText(data.description||"",120)}`;
             companyLi.hit.snippet = enriched;
           }
         }catch{}
       }
       for(const owner of owner_names.slice(0,MAX_PROXYCURL_CALLS-proxycurlCalls)){
         let ownerLi = allSerpHits.find(h=>h.hit.link.includes("linkedin.com/in/") &&
           (h.hit.title||"").toLowerCase().includes(owner.toLowerCase()));
         if(!ownerLi){
           try{
             const r=await postJSON<SerperResponse>(
               SERPER_API_URL,{q:`"${owner}" "${canon}" site:linkedin.com/in/`,num:1,gl:"us",hl:"en"},
               {"X-API-KEY":SERPER_KEY!});
             serperQueries++;
             if(r.organic?.[0]){ ownerLi={hit:r.organic[0],dorkType:"Leadership"}; allSerpHits.unshift(ownerLi);}
           }catch{}
         }
         if(ownerLi && proxycurlCalls<MAX_PROXYCURL_CALLS){
           try{
             const p=await postJSON<ProxyCurlProfileResult>(
               `${PROXYCURL_API_PROFILE_URL}?url=${encodeURIComponent(ownerLi.hit.link)}&fallback_to_cache=on-error&use_cache=if-present`,
               {},{Authorization:`Bearer ${PROXYCURL_KEY!}`},"GET");
             proxycurlCalls++;
             if(p){
               ownerLi.hit.snippet = `${p.full_name||owner} – ${p.headline||"Headline N/A"}. ${truncateText(p.summary||"",100)}`;
             }
           }catch{}
         }
       }
     }
   
     /*──────────────── PHASE 2 — choose Firecrawl targets ───────────*/
     prioritizedScrapingTargets = selectTopScrapingTargets(
       allSerpHits, canon, domain, MAX_FIRECRAWL_TARGETS);
   
     /*──────────────── PHASE 3 — Firecrawl + extraction ─────────────*/
     const firecrawlStart = performance.now();
     for(const hit of prioritizedScrapingTargets){
       if(performance.now()-firecrawlStart>FIRECRAWL_GLOBAL_BUDGET_MS ||
          performance.now()-t0>MAX_WALL_TIME_MS*0.9) break;
   
       const citationMarker = `[${citations.length+1}]`;
       citations.push({
         marker:citationMarker,url:hit.link,title:hit.title||"Untitled",
         snippet:truncateText(hit.snippet||hit.title||"",250),
       });
   
       /* files */
       if(FILE_EXT_REGEX.test(hit.link)){
         filesForManualReview.push({
           url:hit.link,title:hit.title||"Untitled",serpSnippet:hit.snippet||"",
           predictedInterest:await predictFileInterest(hit.link,hit.title||"Untitled",hit.snippet||""),
           citationMarker});
         continue;
       }
   
       if(processedUrls.has(hit.link)) continue;
   
       const scrape = await firecrawlWithLogging(hit.link,`Target ${processedUrls.size+1}/${prioritizedScrapingTargets.length}`);
       processedUrls.add(hit.link);
   
       if(scrape===FIRECRAWL_SKIPPED){
         filesForManualReview.push({
           url:hit.link,title:hit.title||"Untitled",serpSnippet:hit.snippet||"",
           predictedInterest:"Page could not be loaded by Firecrawl",
           citationMarker});
         continue;
       }
       if(typeof scrape==="string" && scrape.length>150){
         if (
           typeof scrape === "string" &&
           !scrape.toLowerCase().includes(canon.toLowerCase())
         ) {
           continue;   // page not about the company – ignore
         }
         const insights = await extractInsightsFromPage(scrape,hit.link,canon,domain,owner_names);
         insights.forEach((ins:ExtractedInsight)=>{
           const sec=ins.categorySuggestion;
           if(bulletsBySection[sec].length<MAX_BULLETS_PER_SECTION){
             bulletsBySection[sec].push({
               text:ins.insightStatement,
               quote:ins.supportingQuote,
               sourceUrl:ins.sourceUrl,
               citationMarker,
               severity:ins.severitySuggestion,
               origin:"llm_insight",
               llmSuggestedCategory:ins.categorySuggestion,
             });
           }
         });
       }else if(hit.snippet && hit.snippet.length>70){
         if(bulletsBySection.Misc.length<MAX_BULLETS_PER_SECTION)
           bulletsBySection.Misc.push({
             text:truncateText(hit.snippet,MAX_BULLET_LENGTH),
             sourceUrl:hit.link,citationMarker,
             severity:RISK_WORDS_OS.test(hit.snippet.toLowerCase())?"MEDIUM":"LOW",
             origin:"heuristic_snippet"});
       }
     }
     const pagesForDeepAnalysis = processedUrls.size - filesForManualReview.length;
   
     /*──────────────── PHASE 4 — section & exec summaries ───────────*/
     for(const sec of SECTIONS){
       const arr = bulletsBySection[sec];
       if(arr.length===0){
         sectionsOutput.push({name:sec,summary:"No specific findings.",bullets:[]});
         continue;
       }
       llmSummaryCalls++;
       const prompt = `Summarise the following ${sec} findings for "${company_name}":\n`+
         arr.slice(0,20).map(b=>`- ${b.text}`).join("\n");
       const sum = await callLlm(prompt,"You are a due-diligence analyst.",
         LLM_MODEL_SUMMARIZATION, MAX_TOKENS_SECTION_SUMMARY,0.2);
       sectionsOutput.push({name:sec,summary:sum||"Summary unavailable.",bullets:arr});
     }
   
     llmSummaryCalls++;
     const high = sectionsOutput.flatMap(s=>s.bullets)
       .filter(b=>["CRITICAL","HIGH"].includes(b.severity))
       .slice(0,10).map(b=>`- ${b.text}`).join("\n");
     executiveSummary = await callLlm(
   `Prepare a concise executive summary of the most critical findings for "${company_name}".\n${high || "No high-severity findings."}`,
   "You are a principal OSINT investigator.",
   LLM_MODEL_SUMMARIZATION, MAX_TOKENS_EXEC_SUMMARY,0.2) || "Executive summary unavailable.";
   
     /*──────────────── COST & RETURN ───────────────────────────────*/
     const llmCost = calcLlmCost(totalLlmIn,totalLlmOut);
     const cost = {
       serper   : serperQueries*0.001,
       firecrawl: firecrawlAttempts*0.002,
       proxycurl: proxycurlCalls*0.01,
       llm      : +llmCost.toFixed(4),
       total    : +(serperQueries*0.001 + firecrawlAttempts*0.002 + proxycurlCalls*0.01 + llmCost).toFixed(4),
     };
   
     const wallTimeSeconds = +((performance.now()-t0)/1000).toFixed(1);
   
     return {
       company  : company_name,
       domain,
       generated: new Date().toISOString(),
       summary  : executiveSummary,
       sections : sectionsOutput,
       citations: citations.slice(
         0,
         MAX_SOURCES_TO_LLM * 2 + owner_names.length + 10,
       ),
       filesForManualReview,
       cost,
       stats:{
         serperQueries,
         serperResultsProcessed,
         firecrawlTargets: prioritizedScrapingTargets.length,
         firecrawlAttempts,
         firecrawlSuccesses,
         pagesForDeepAnalysis,
         llmInsightExtractionCalls: llmInsightCalls,
         llmSummarizationCalls   : llmSummaryCalls,
         llmFilePredictionCalls  : llmFileCalls,
         totalLlmInputTokens     : totalLlmIn,
         totalLlmOutputTokens    : totalLlmOut,
         proxycurlCalls,
         wallTimeSeconds,
       },
     };
   }
   