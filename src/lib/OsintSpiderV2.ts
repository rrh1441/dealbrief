/* ──────────────────────────────────────────────────────────────────────────
   src/lib/OsintSpiderV-FixedFirecrawl.ts (Based on your OsintSpider V3)
   --------------------------------------------------------------------------
   Web-only due diligence
     • Serper ≤600    • Firecrawl ≤200   • ProxyCurl ≤10
     • GPT-4.1-mini for summaries
     • 6 sections, ≤50 bullets each
     • Strict TypeScript, aiming for zero implicit any
   ------------------------------------------------------------------------ */

   import { createHash } from "node:crypto";
   import { performance } from "node:perf_hooks";
   import fetch, { Response as FetchResponse, RequestInit } from "node-fetch";
   import { z } from "zod";
   import OpenAI from "openai";
   
   export const runtime = "nodejs";
   
   /*────────────────────────── ENV ──────────────────────────*/
   const {
     SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY,
   } = process.env;
   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
     // Throwing an error is better for critical missing keys
     throw new Error("CRITICAL ERROR: Missing one or more API keys (SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY).");
   }
   
   /*──────────────────────── CONSTANTS ──────────────────────*/
   const SERPER_API_URL  = "https://google.serper.dev/search";
   const FIRECRAWL_API_URL    = "https://api.firecrawl.dev/v1/scrape"; // Matching MeetingBrief
   const PROXYCURL_API_COMPANY_URL  = "https://nubela.co/proxycurl/api/linkedin/company"; // From your OsintSpiderV3
   const PROXYCURL_API_PROFILE_URL  = "https://nubela.co/proxycurl/api/v2/linkedin";  // From your OsintSpiderV3
   
   const MAX_SERPER_CALLS   = 600;
   const MAX_SERP_RESULTS_PER_PAGE = 10; // 'num' parameter for Serper
   const MAX_FIRECRAWL_ATTEMPTS     = 200; // Max attempts, not necessarily successes
   const MAX_PROXYCURL_CALLS     = 10;
   const FIRECRAWL_BATCH_SIZE   = 10; // Matching MeetingBrief for consistency
   // Timeouts for firecrawlWithLogging are internal to that function (7s, then 15s)
   const MAX_WALL_TIME_MS      = 12 * 60 * 1000;
   
   const LLM_MODEL_ID        = "gpt-4.1-mini-2025-04-14"; // Matching MeetingBrief
   
   const SECTIONS = ["Corporate","Legal","Cyber","Reputation","Leadership","Misc"] as const;
   type SectionName = typeof SECTIONS[number];
   
   const MAX_BULLETS_PER_SECTION  = 50;
   const MAX_BULLET_LENGTH  = 500;
   const MAX_TOKENS_EXEC_SUMMARY    = 300;
   const MAX_TOKENS_SECTION_SUMMARY = 160;
   const MAX_SOURCES_TO_LLM = 30; // Max sources to consider for LLM processing to manage token count
   
   /*──────────────────────── TYPES ──────────────────────────*/
   type Severity = "CRITICAL"|"HIGH"|"MEDIUM"|"LOW";
   interface Bullet   { text:string; source:number; sev:Severity } // source is 1-indexed
   interface Section  { name:SectionName; summary:string; bullets:Bullet[] }
   interface Citation { marker:string; url:string; title:string; snippet:string } // 1-indexed in display
   
   interface SerperOrganicResult { title:string; link:string; snippet?:string }
   interface SerperResponse    { organic?:SerperOrganicResult[] }
   
   // Using FirecrawlScrapeV1Result from MeetingBrief for consistency and detail
   interface FirecrawlScrapeV1Result {
       success: boolean;
       data?: {
           content: string; markdown: string; text_content: string;
           metadata: Record<string, string | number | boolean | undefined | null>;
           article?: { title?: string; author?: string; publishedDate?: string; text_content?: string; };
       };
       error?: string; status?: number;
   }
   
   interface ProxyCurlProfileResult { headline?:string; [key: string]: unknown; } // From OsintSpiderV3, made index unknown
   interface ProxyCurlCompanyResult { industry?:string; founded_year?:number; [key: string]: unknown; } // From OsintSpiderV3, made index unknown
   
   export interface OsintSpiderPayload{ // Renamed from SpiderPayload for clarity
     company:string; domain:string; generated:string;
     summary:string; sections:Section[]; citations:Citation[];
     cost:{ serper:number; firecrawl:number; proxycurl:number; llm:number; total:number };
     stats: { serperCalls: number; firecrawlAttempts: number; firecrawlSuccesses: number; proxycurlCalls: number; llmTokenCostPence: number};
   }
   
   /*────────────────────── INPUT SCHEMA ───────────────────*/
   const osintSpiderInputSchema = z.object({
     company_name: z.string().trim().min(1),
     domain:       z.string().trim().min(3),
     owner_names:  z.array(z.string().trim()).optional(),
   });
   
   /*──────────────────────── HELPERS ───────────────────────*/
   const sha256 = (s:string):string => createHash("sha256").update(s).digest("hex");
   const truncateText  = (s:string,n:number):string => (s || "").length<=n? (s || "") : (s || "").slice(0,n-1)+"…";
   const estimateTokens = (s:string):number => Math.ceil((s || "").length/3.5); // Adjusted from OsintSpiderV3's tokens()
   
   // LLM cost calculation (example prices, adjust to actuals for gpt-4.1-mini)
   // gpt-4o-mini: $0.15 / 1M input tokens, $0.60 / 1M output tokens
   const INPUT_TOKEN_PRICE_PER_MILLION = 0.15;
   const OUTPUT_TOKEN_PRICE_PER_MILLION = 0.60;
   const calculateLlmCost = (inputTokens:number, outputTokens:number): number =>
     (inputTokens / 1_000_000 * INPUT_TOKEN_PRICE_PER_MILLION) +
     (outputTokens / 1_000_000 * OUTPUT_TOKEN_PRICE_PER_MILLION);
   
   
   /* cheap "stem" for basic deduplication - from OsintSpiderV3 */
   const cheapStem = (s:string):string =>
     (s || "").toLowerCase().split(/\W+/).map(w=>w.replace(/[aeiou]/g,"").slice(0,4)).join("");
   
   /* LLM wrapper from OsintSpiderV3, with cost tracking */
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   let totalLlmInputTokens = 0;
   let totalLlmOutputTokens = 0;
   
   async function callLlm(prompt:string, context:string, maxOutputTokens:number):Promise<string>{
     const currentInputTokens = estimateTokens(prompt) + estimateTokens(context);
     totalLlmInputTokens += currentInputTokens;
   
     const result = await ai.chat.completions.create({
       model: LLM_MODEL_ID, temperature: 0.25, max_tokens: maxOutputTokens,
       messages:[{role:"system",content:prompt},{role:"user",content:context}],
     });
   
     const completionTokens = result.usage?.completion_tokens ?? estimateTokens(result.choices[0].message.content || "");
     totalLlmOutputTokens += completionTokens;
   
     return (result.choices[0].message.content || "").trim();
   }
   
   // Using the lint-fixed postJSON from MeetingBrief
   const postJSON = async <T>(
     url: string,
     body: unknown,
     headers: Record<string, string>,
     method: "POST" | "GET" = "POST",
   ): Promise<T> => {
     const options: RequestInit = {
       method: method,
       headers: { ...headers, "Content-Type": "application/json" },
     };
     if (method === "POST") {
       options.body = JSON.stringify(body);
     }
     const response: FetchResponse = await fetch(url, options);
     if (!response.ok) {
       const errorText = await response.text();
       console.error(`postJSON Error: HTTP ${response.status} for ${url}. Body: ${errorText.slice(0, 500)}`);
       throw new Error(`HTTP ${response.status} – ${errorText}`);
     }
     const responseText = await response.text();
     try {
       const parsedJson: unknown = JSON.parse(responseText);
       return parsedJson as T;
     } catch (e: unknown) {
       const err = e instanceof Error ? e : new Error(String(e));
       console.error(`postJSON: Failed to parse JSON response from ${url}. Error: ${err.message}. Response text snippet: ${responseText.slice(0, 200)}...`);
       throw new Error(`Failed to parse JSON response from ${url}: ${err.message}`);
     }
   };
   
   /* ── Firecrawl with Logging and Retry (from MeetingBrief)──────────────── */
   let firecrawlGlobalAttempts = 0;
   let firecrawlGlobalSuccesses = 0;
   
   const firecrawlWithLogging = async (url: string, attemptInfoForLogs: string): Promise<string | null> => {
     firecrawlGlobalAttempts++;
     const tryScrapeOnce = async (timeoutMs: number): Promise<string | null> => {
       try {
         console.log(`[Firecrawl Attempt] ${attemptInfoForLogs} - URL: ${url}, Timeout: ${timeoutMs}ms`);
         const response = await Promise.race([
           postJSON<FirecrawlScrapeV1Result>(
             FIRECRAWL_API_URL, { url }, { Authorization: `Bearer ${FIRECRAWL_KEY!}` }
           ),
           new Promise<never>((_, reject) =>
             setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
           ),
         ]);
   
         if (response && response.success && response.data?.article && typeof response.data.article.text_content === 'string') {
           console.log(`[Firecrawl Success] ${attemptInfoForLogs} - URL: ${url}. Got article.text_content (length: ${response.data.article.text_content.length})`);
           firecrawlGlobalSuccesses++;
           return response.data.article.text_content;
         } else if (response && response.success && response.data) {
            const fallbackText = response.data.text_content || response.data.markdown;
            if (fallbackText && typeof fallbackText === 'string') {
               console.warn(`[Firecrawl PartialSuccess] ${attemptInfoForLogs} - URL: ${url}. No article.text_content, but found other text (length: ${fallbackText.length}).`);
               firecrawlGlobalSuccesses++; // Still count as a success if we get some usable text
               return fallbackText;
            }
           console.warn(`[Firecrawl NoContent] ${attemptInfoForLogs} - URL: ${url}. Response success=true but no usable text_content/markdown. Full Response: ${JSON.stringify(response).slice(0,300)}...`);
           return null;
         } else if (response && !response.success) {
           console.error(`[Firecrawl API Error] ${attemptInfoForLogs} - URL: ${url}. Error: ${response.error || 'Unknown Firecrawl error'}. Status: ${response.status || 'N/A'}`);
           return null;
         } else {
           // This case implies the Promise.race resolved with something unexpected, or postJSON returned something not matching FirecrawlScrapeV1Result.
           console.warn(`[Firecrawl OddResponse] ${attemptInfoForLogs} - URL: ${url}. Unexpected response structure: ${JSON.stringify(response).slice(0,300)}...`);
           return null;
         }
       } catch (error: unknown) {
         const err = error instanceof Error ? error : new Error(String(error));
         console.error(`[Firecrawl Exception] ${attemptInfoForLogs} - URL: ${url}, Timeout: ${timeoutMs}ms. Error: ${err.message}`, err.stack ? `\nStack: ${err.stack.slice(0,300)}` : '');
         return null;
       }
     };
   
     let content = await tryScrapeOnce(7000); // 7s initial timeout
     if (content === null) {
       console.warn(`[Firecrawl Retry] First attempt failed for ${url} (${attemptInfoForLogs}). Retrying.`);
       content = await tryScrapeOnce(15000); // 15s retry timeout
       if (content === null) console.error(`[Firecrawl FailedAllAttempts] URL: ${url} (${attemptInfoForLogs}).`);
     }
     return content;
   };
   
   
   /*──────────────────────── REGEX & SCORE from OsintSpiderV3 ────────────────*/
   const RE_EMAIL_OS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi; // Renamed to avoid conflict if any
   const RE_PHONE_OS = /\b\+?\d[\d\s().-]{6,}\d\b/g;
   const RE_SECRET_OS = /\b(api[_-]?key|token|secret|password|authorization|bearer)\b/i;
   const RE_PDFXLS_OS = /\.(pdf|xlsx)$/i;
   const RISK_WORDS_OS = /breach|leak|ransom|hack|apikey|secret|password|lawsuit|contract|invoice|pii/i;
   
   const classifyFinding = (s:string):Severity => { // Renamed from classify
     const t = (s || "").toLowerCase();
     if(RE_SECRET_OS.test(t)) return "CRITICAL";
     if(RISK_WORDS_OS.test(t)) return "HIGH";
     if(/index of/.test(t)||RE_PDFXLS_OS.test(t)) return "MEDIUM";
     return "LOW";
   };
   
   const jaccardSimilarity = (a:string, b:string):number => { // Renamed from jaccard
     const A=new Set((a || "").toLowerCase().split(/\W+/));
     const B=new Set((b || "").toLowerCase().split(/\W+/));
     const intersectionSize = [...A].filter(x=>B.has(x)).length;
     const unionSize = A.size + B.size - intersectionSize;
     return unionSize === 0 ? 0 : intersectionSize / unionSize;
   };
   
   const scoreSerpResult = (o:SerperOrganicResult, domain:string):number => { // Renamed from scoreSerp
     let s=0;
     const snippetText = o.snippet || "";
     const titleText = o.title || "";
   
     if(o.link.includes(domain)) s+=0.3;
     if(RE_EMAIL_OS.test(snippetText)||RE_PHONE_OS.test(snippetText)) s+=0.2;
     if(/\.(gov|edu|mil)/.test(o.link)||RE_PDFXLS_OS.test(o.link))    s+=0.2;
     if(RISK_WORDS_OS.test(snippetText))                           s+=0.2;
     if(/index of|error/i.test(titleText)) s+=0.1;
     return s;
   };
   
   /*──────────────────────── MAIN OsintSpider Function ─────────────────────────*/
   export async function runOsintSpider(raw:unknown):Promise<OsintSpiderPayload>{
     const t0 = performance.now();
     // Reset global counters for each run
     firecrawlGlobalAttempts = 0;
     firecrawlGlobalSuccesses = 0;
     totalLlmInputTokens = 0;
     totalLlmOutputTokens = 0;
     let serperCalls = 0;
     let proxycurlCalls = 0; // Changed from curl to proxycurlCalls for clarity
   
     const { company_name, domain, owner_names=[] } = osintSpiderInputSchema.parse(raw);
   
     const companyCanon = company_name.toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
       .replace(/[.,']/g,"").trim();
   
     /* containers from OsintSpiderV3 */
     const bulletsBySection:Record<SectionName,Bullet[]>={ // Renamed for clarity
       Corporate:[],Legal:[],Cyber:[],Reputation:[],Leadership:[],Misc:[],
     };
     const citationsList:Citation[]=[]; // Renamed for clarity
     const stemSeenSet = new Set<string>(); // Renamed for clarity
     const hostBulletCount:Record<string,number>={}; // Renamed for clarity
   
     /*──── dork queue from OsintSpiderV3 ────*/
     const queryBase = (kw:string):string => `("${companyCanon}" OR "${domain}") ${kw}`;
     const queryQueue:string[]=[ // Renamed for clarity
       queryBase("filetype:pdf"),
       queryBase("filetype:xlsx"),
       queryBase('site:*.gov'),
       `"@${domain}" site:github.com`, // This dork might be too broad or specific, test
       `"${companyCanon}"`,
       `"${companyCanon}" site:${domain}`,
       queryBase('("breach" OR "leak" OR "ransom" OR "vulnerability")'), // Added vulnerability
       queryBase('("password" OR "apikey" OR "secret" OR "credentials")'), // Added credentials
       queryBase('("lawsuit" OR "litigation" OR "sec filing" OR "complaint")'), // Added sec filing & complaint
     ];
     owner_names.forEach(o=>queryQueue.push(`"${o}" ("${companyCanon}" OR "${domain}")`));
     const queriedDorks = new Set(queryQueue); // Renamed for clarity
     const processedUrls = new Set<string>(); // Renamed for clarity
   
     interface HitRecord {title:string;link:string;snippet?:string;score:number} // From OsintSpiderV3
     const collectedHits:HitRecord[]=[]; // Renamed for clarity
   
     /*──────── SERPER BFS from OsintSpiderV3 ───────*/
     console.log(`[OsintSpider] Starting SERPER BFS for "${companyCanon}"`);
     while(queryQueue.length && serperCalls<MAX_SERPER_CALLS && performance.now()-t0<MAX_WALL_TIME_MS){
       const currentDork = queryQueue.shift()!;
       console.log(`[OsintSpider] Serper Query: ${currentDork}`);
       try {
         const serperResponse = await postJSON<SerperResponse>(
           SERPER_API_URL,{q:currentDork,num:MAX_SERP_RESULTS_PER_PAGE,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!});
         serperCalls++;
         for(const organicResult of serperResponse.organic || []){
           const url=organicResult.link; if(!url) continue;
           const canonicalUrl=url.replace(/(\?|#).*/,""); // Remove query params and fragments for uniqueness
           if(processedUrls.has(canonicalUrl)) continue;
   
           const joinedText=(organicResult.title+(organicResult.snippet || "")).toLowerCase();
           if(!joinedText.includes(companyCanon)&&!joinedText.includes(domain)) continue; // Basic relevance check
           // Jaccard might be too aggressive or not tuned for snippets. Consider its impact.
           if(jaccardSimilarity(organicResult.title,organicResult.snippet??"") > 0.85 && (organicResult.snippet || "").length > 20) continue;
   
           processedUrls.add(canonicalUrl);
           collectedHits.push({
               title:organicResult.title,
               link:url,
               snippet:organicResult.snippet,
               score:scoreSerpResult(organicResult,domain)
           });
   
           /* host expansion from OsintSpiderV3 */
           try{
             const hitHostname=new URL(url).hostname.replace(/^www\./, "");
             // Avoid re-querying primary domain or already queried hosts extensively
             if(hitHostname !== domain && !queriedDorks.has(hitHostname) && (hostBulletCount[hitHostname] || 0) < 3) { // Limit host expansion queries
               queriedDorks.add(hitHostname);
               queryQueue.push(`("${companyCanon}" OR "${domain}") site:${hitHostname}`);
             }
           }catch{/* ignore invalid URL for hostname extraction */}
         }
       } catch (e:unknown) {
           const err = e instanceof Error ? e : new Error(String(e));
           console.warn(`[OsintSpider] Serper call failed for dork "${currentDork}". Error: ${err.message}`);
       }
     }
     collectedHits.sort((a,b)=>b.score-a.score); // Sort by calculated score
     console.log(`[OsintSpider] Serper BFS finished. Collected ${collectedHits.length} hits from ${serperCalls} calls.`);
   
     /*──────── ProxyCurl enrich from OsintSpiderV3 ─────*/
     console.log(`[OsintSpider] Starting ProxyCurl enrichment.`);
     const linkedInCompanyHit=collectedHits.find(h=>h.link.includes("linkedin.com/company/"));
     if(linkedInCompanyHit && proxycurlCalls < MAX_PROXYCURL_CALLS){
       try {
         const companyData = await postJSON<ProxyCurlCompanyResult>( // Using POST as per original OsintSpiderV3 postJSON, though ProxyCurl is usually GET
           `${PROXYCURL_API_COMPANY_URL}?url=${encodeURIComponent(linkedInCompanyHit.link)}`, // URL in query string for GET usually
           {}, // Empty body for GET
           {Authorization:`Bearer ${PROXYCURL_KEY!}`},
           "GET" // Explicitly GET
         );
         proxycurlCalls++;
         if(companyData){
           collectedHits.unshift({
               ...linkedInCompanyHit,
               snippet:`${companyData.industry??"Industry N/A"} - Founded: ${companyData.founded_year??"Year N/A"}`.trim(),
               score:0.8 // Boost score for enriched company profile
           });
           console.log(`[OsintSpider] Enriched company profile from LinkedIn: ${linkedInCompanyHit.link}`);
         }
       } catch (e:unknown) {
           const err = e instanceof Error ? e : new Error(String(e));
           console.warn(`[OsintSpider] ProxyCurl company enrichment failed for ${linkedInCompanyHit.link}. Error: ${err.message}`);
       }
     }
   
     for(const ownerName of owner_names.slice(0, Math.max(0, MAX_PROXYCURL_CALLS - proxycurlCalls)) ){ // Limit owner lookups
       if(proxycurlCalls>=MAX_PROXYCURL_CALLS) break;
       let ownerLinkedInUrl: string | undefined;
       // First, check if a LinkedIn profile for the owner is already in hits
       const ownerHit = collectedHits.find(h => h.link.includes("linkedin.com/in/") && (h.title.toLowerCase().includes(ownerName.toLowerCase()) || (h.snippet||"").toLowerCase().includes(ownerName.toLowerCase())));
       if (ownerHit) {
           ownerLinkedInUrl = ownerHit.link;
       } else {
           // If not, do a targeted Serper search
           console.log(`[OsintSpider] Searching LinkedIn profile for owner: ${ownerName}`);
           try {
               const serperOwnerResp = await postJSON<SerperResponse>(SERPER_API_URL,
                 {q:`"${ownerName}" "${companyCanon}" "linkedin.com/in/" site:linkedin.com`,num:1,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!});
               serperCalls++;
               if(serperOwnerResp.organic && serperOwnerResp.organic.length > 0) {
                   ownerLinkedInUrl = serperOwnerResp.organic[0].link;
                   // Add this found profile to hits so it can be cited
                   if(ownerLinkedInUrl && !collectedHits.some(h => h.link === ownerLinkedInUrl)) {
                       collectedHits.unshift({title: serperOwnerResp.organic[0].title, link: ownerLinkedInUrl, snippet: serperOwnerResp.organic[0].snippet, score: 0.75});
                   }
               }
           } catch (e:unknown) {
               const err = e instanceof Error ? e : new Error(String(e));
               console.warn(`[OsintSpider] Serper search for owner ${ownerName}'s LinkedIn failed. Error: ${err.message}`);
           }
       }
   
       if(ownerLinkedInUrl && proxycurlCalls < MAX_PROXYCURL_CALLS) {
         console.log(`[OsintSpider] Enriching owner profile via ProxyCurl: ${ownerName} - ${ownerLinkedInUrl}`);
         try {
           const profileData = await postJSON<ProxyCurlProfileResult>( // Using POST as per original OsintSpiderV3 postJSON
             `${PROXYCURL_API_PROFILE_URL}?linkedin_profile_url=${encodeURIComponent(ownerLinkedInUrl)}`, // URL in query string
             {}, // Empty body for GET
             {Authorization:`Bearer ${PROXYCURL_KEY!}`},
             "GET" // Explicitly GET
           );
           proxycurlCalls++;
           if(profileData){
               const existingHitIndex = collectedHits.findIndex(h => h.link === ownerLinkedInUrl);
               const newSnippet = `${ownerName} - ${profileData.headline || "Headline N/A"}`.trim();
               if (existingHitIndex !== -1) {
                   collectedHits[existingHitIndex] = {...collectedHits[existingHitIndex], snippet: newSnippet, score: Math.max(collectedHits[existingHitIndex].score, 0.75)};
               } else { // Should have been added by Serper search if newly found
                   collectedHits.unshift({title:`${ownerName} – LinkedIn Profile`,link:ownerLinkedInUrl,snippet:newSnippet,score:0.75});
               }
                console.log(`[OsintSpider] Enriched owner profile for ${ownerName}.`);
           }
         } catch (e:unknown) {
           const err = e instanceof Error ? e : new Error(String(e));
           console.warn(`[OsintSpider] ProxyCurl profile enrichment failed for ${ownerName}. Error: ${err.message}`);
         }
       }
     }
     // Re-sort hits after ProxyCurl enrichment as scores might have changed
     collectedHits.sort((a,b)=>b.score-a.score);
     console.log(`[OsintSpider] ProxyCurl enrichment finished. ${proxycurlCalls} calls made.`);
   
   
     /*──────── Firecrawl with NEW LOGIC ───────*/
     const firecrawlTargets = collectedHits.slice(0, MAX_FIRECRAWL_ATTEMPTS); // Target up to MAX_FIRECRAWL_ATTEMPTS
     const scrapedContentMap = new Map<string, string>(); // sha256(link) -> scraped_text
     let firecrawlWallTimeSpent = 0;
   
     console.log(`[OsintSpider] Starting Firecrawl for up to ${firecrawlTargets.length} targets.`);
     for (let i = 0; i < firecrawlTargets.length && firecrawlGlobalAttempts < MAX_FIRECRAWL_ATTEMPTS; i += FIRECRAWL_BATCH_SIZE) {
       const batchStartTime = performance.now();
       if (batchStartTime - t0 + firecrawlWallTimeSpent > MAX_WALL_TIME_MS - 5000) { // Leave some buffer
           console.warn("[OsintSpider] Approaching max wall time, stopping Firecrawl early.");
           break;
       }
   
       const batchToScrape = firecrawlTargets.slice(i, i + FIRECRAWL_BATCH_SIZE);
       await Promise.allSettled( // Use allSettled to ensure all attempts complete
         batchToScrape.map(async (hit, indexInBatch) => {
           if (performance.now() - t0 > MAX_WALL_TIME_MS) return; // Check wall time per item too
   
           const attemptInfo = `OsintSpider Batch ${Math.floor(i / FIRECRAWL_BATCH_SIZE) + 1}, Item ${indexInBatch + 1}/${batchToScrape.length}, GlobalAttempt ${firecrawlGlobalAttempts + 1}`;
           const scrapedText = await firecrawlWithLogging(hit.link, attemptInfo);
           if (scrapedText) {
             scrapedContentMap.set(sha256(hit.link), scrapedText);
           }
         })
       );
       firecrawlWallTimeSpent += (performance.now() - batchStartTime);
       console.log(`[OsintSpider] Firecrawl Batch ${Math.floor(i / FIRECRAWL_BATCH_SIZE) + 1} processed. Total Firecrawl attempts: ${firecrawlGlobalAttempts}, Successes: ${firecrawlGlobalSuccesses}`);
     }
     console.log(`[OsintSpider] Firecrawl phase finished. Attempts: ${firecrawlGlobalAttempts}, Successes: ${firecrawlGlobalSuccesses}.`);
   
   
     /*──────── Bullet & Citations from OsintSpiderV3 (operates on scrapedContentMap or snippets) ─────────*/
     console.log(`[OsintSpider] Generating bullets and citations.`);
     // Use firecrawlTargets as these are the ones we attempted to scrape
     firecrawlTargets.forEach((hit, idx) => {
       if (idx >= MAX_SOURCES_TO_LLM * 2 && citationsList.length >= MAX_SOURCES_TO_LLM) return; // Limit citations if too many sources processed
   
       const scrapedText = scrapedContentMap.get(sha256(hit.link));
       const bodyForBullet = scrapedText ?? hit.snippet ?? hit.title; // Prioritize scraped text
       const textForBullet = truncateText(bodyForBullet.replace(/\s+/g," ").trim(), MAX_BULLET_LENGTH);
   
       // Add to citationsList first
       const citationNumber = citationsList.length + 1;
       citationsList.push({
           marker:`[${citationNumber}]`,
           url:hit.link,
           title:hit.title,
           snippet:truncateText(hit.snippet || bodyForBullet, 250) // Use original snippet or body for citation snippet
       });
   
       // Original OsintSpiderV3 sectioning logic
       let section:SectionName="Corporate"; // Default
       if(hit.link.includes("github.com")||hit.link.includes("pastebin")) section="Cyber";
       else if(/sec\.gov|10-q|10-k|court|legalcase/i.test(hit.link) || RISK_WORDS_OS.test(textForBullet) && textForBullet.match(/lawsuit|litigation|judge|attorney/i)) section="Legal";
       else if(hit.link.includes("linkedin.com")) section="Leadership";
       else if(/twitter|facebook|nextdoor|yelp|review|rating/i.test(hit.link) || RISK_WORDS_OS.test(textForBullet) && textForBullet.match(/complaint|scandal|controversy/i) ) section="Reputation";
       else if(classifyFinding(textForBullet)==="CRITICAL"||classifyFinding(textForBullet)==="HIGH") section="Cyber"; // If risk words make it Cyber
   
   
       // Original OsintSpiderV3 addBullet logic (adapted)
       if(bulletsBySection[section].length >= MAX_BULLETS_PER_SECTION) return;
       // Relevance check (from original OsintSpiderV3)
       if(!textForBullet.toLowerCase().includes(companyCanon) && !textForBullet.toLowerCase().includes(domain) && !owner_names.some(o => textForBullet.toLowerCase().includes(o.toLowerCase())) ) {
           // Allow if from company's own domain or highly scored even if name not repeated in short bullet
           if (!hit.link.includes(domain) && hit.score < 0.5) return;
       }
   
       if(section==="Cyber" && !RISK_WORDS_OS.test(textForBullet) && !RE_SECRET_OS.test(textForBullet)) {
           // If heuristically it's Cyber but no risk words in bullet, maybe re-classify or skip
           if (!hit.link.includes("github.com") && !hit.link.includes("pastebin")) return; // Stricter gate
       }
   
       const signature = cheapStem(textForBullet).slice(0,120); // Basic deduplication stem
       if(stemSeenSet.has(signature)) return;
       stemSeenSet.add(signature);
   
       const hitHostname= (() => { try { return new URL(hit.link).hostname.replace(/^www\./, ""); } catch { return "unknown_host"; } })();
       if((hostBulletCount[hitHostname]=(hostBulletCount[hitHostname]??0)+1) > 6 && hitHostname !== domain) return; // Limit bullets per external host
   
       bulletsBySection[section].push({text:textForBullet, source:citationNumber, sev:classifyFinding(textForBullet)});
     });
     console.log(`[OsintSpider] Generated ${citationsList.length} citations and distributed bullets into sections.`);
   
   
     /*──────── Section summaries (from OsintSpiderV3) ─────────*/
     console.log(`[OsintSpider] Generating LLM section summaries.`);
     const sectionsOutput:Section[] = await Promise.all(SECTIONS.map(async sectionName=>{
       const currentBullets=bulletsBySection[sectionName];
       if(!currentBullets.length) return {name:sectionName,summary:"No significant findings in this section.",bullets:currentBullets};
   
       const criticalCount=currentBullets.filter(b=>b.sev==="CRITICAL").length;
       const highCount=currentBullets.filter(b=>b.sev==="HIGH").length;
       const contextForLlm = currentBullets.slice(0, 20).map(b=>`- ${b.text} (Severity: ${b.sev}, Source: ${b.source})`).join("\n"); // Provide more context
   
       const summaryPrompt = `You are a due diligence analyst summarizing findings for the "${sectionName}" section regarding "${companyCanon}".
   Based ONLY on the following bullet points (max 20 shown), write a concise summary of 1-3 sentences.
   Focus on the most impactful information. Mention counts of CRITICAL/HIGH findings if significant. Do not invent facts or speculate.
   Bullet points:
   ${contextForLlm}`;
       const systemPrompt = "Produce a brief, factual summary for a due diligence report section.";
   
       return {
         name: sectionName,
         summary: await callLlm(systemPrompt, summaryPrompt, MAX_TOKENS_SECTION_SUMMARY), // Swapped prompt and context order for callLlm
         bullets:currentBullets, // Return all bullets for the section, not just those sent to LLM
       };
     }));
     console.log(`[OsintSpider] LLM section summaries generated.`);
   
     /*──────── Executive summary (from OsintSpiderV3) ─────────*/
     console.log(`[OsintSpider] Generating LLM executive summary.`);
     // Create a more focused context for the executive summary from section summaries and top critical/high bullets
     let execSummaryContext = sectionsOutput.map(s => `Section: ${s.name}\nSummary: ${s.summary}`).join("\n\n");
     const topCriticalHighBullets = sectionsOutput
       .flatMap(s => s.bullets)
       .filter(b => b.sev === "CRITICAL" || b.sev === "HIGH")
       .sort((a,b) => (a.sev === "CRITICAL" ? -1 : 1) - (b.sev === "CRITICAL" ? -1 : 1) || (a.sev === "HIGH" ? -1 : 1) - (b.sev === "HIGH" ? -1 : 1) ) // Sort CRITICAL first, then HIGH
       .slice(0, 5) // Top 5 critical/high
       .map(b => `- ${b.text} (Severity: ${b.sev}, Source: ${b.source})`)
       .join("\n");
   
     if (topCriticalHighBullets) {
       execSummaryContext += `\n\nKey Critical/High Findings:\n${topCriticalHighBullets}`;
     } else if (!execSummaryContext.trim() || sectionsOutput.every(s => s.summary.includes("No significant findings"))) {
         execSummaryContext = "No specific critical or high-impact findings were identified based on the available web data. The company maintains a general online presence. Further investigation may be required for a comprehensive assessment.";
     }
   
   
     const executiveSummaryPrompt = `You are writing a 3-5 sentence executive summary for a web-only OSINT due diligence report on "${companyCanon}".
   Based ONLY on the provided section summaries and key critical/high findings below, synthesize a high-level overview.
   Focus on the most impactful intelligence (positive or negative). Avoid jargon. Be objective.`;
     const execSystemPrompt = "Produce a concise, factual executive summary for a due diligence report.";
   
     const executiveSummary = await callLlm(execSystemPrompt, truncateText(execSummaryContext, 4000), MAX_TOKENS_EXEC_SUMMARY); // Swapped prompt and context
     console.log(`[OsintSpider] LLM executive summary generated.`);
   
     /*──────── Cost & Final Payload from OsintSpiderV3 ───────────────────*/
     const finalLlmCost = calculateLlmCost(totalLlmInputTokens, totalLlmOutputTokens);
     const costBreakdown={
       serper: serperCalls * 0.001, // OsintSpiderV3 had 0.005, Serper usually $1/1k for basic plans
       firecrawl: firecrawlGlobalSuccesses * 0.001, // Assuming $1/1k successful scrapes (basic tier)
       proxycurl: proxycurlCalls * 0.01, // OsintSpiderV3 had 0.01
       llm: +finalLlmCost.toFixed(4),
       total: 0,
     };
     costBreakdown.total = +(costBreakdown.serper + costBreakdown.firecrawl + costBreakdown.proxycurl + costBreakdown.llm).toFixed(4);
     const wallTimeMs = performance.now() - t0;
   
     console.log(`[OsintSpider Finished] Wall time: ${wallTimeMs/1000}s. Serper: ${serperCalls}, Firecrawl (A/S): ${firecrawlGlobalAttempts}/${firecrawlGlobalSuccesses}, ProxyCurl: ${proxycurlCalls}, LLM Cost: $${costBreakdown.llm}`);
   
     return {
       company: company_name,
       domain,
       generated: new Date().toISOString(),
       summary: executiveSummary,
       sections: sectionsOutput,
       citations: citationsList.slice(0, MAX_SOURCES_TO_LLM * 2), // Ensure citations list isn't excessively long
       cost: costBreakdown,
       stats: { // Added detailed stats
           serperCalls: serperCalls,
           firecrawlAttempts: firecrawlGlobalAttempts,
           firecrawlSuccesses: firecrawlGlobalSuccesses,
           proxycurlCalls: proxycurlCalls,
           llmTokenCostPence: Math.round(finalLlmCost * 100) // Example in pence if needed
       }
     };
   }
   
   // Example usage (ensure API keys are in environment)
   // async function testOsintSpider() {
   //   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
   //     console.error("Cannot run test: Missing API keys in environment.");
   //     return;
   //   }
   //   try {
   //     const results = await runOsintSpider({
   //       company_name: "South Sound Electric Inc",
   //       domain: "southsoundelectric.com",
   //       owner_names: ["Raymond Boink", "Mike Sturdevant"]
   //     });
   //     console.log(JSON.stringify(results, null, 2));
   //     // To test the output you showed:
   //     // console.log("\n\nDue-Diligence Brief: " + results.company);
   //     // console.log("\nExecutive Summary\n" + results.summary);
   //     // results.sections.forEach(sec => {
   //     //   console.log(`\n${sec.name} — ${sec.summary}`);
   //     //   sec.bullets.forEach(b => console.log(`${b.text.replace(/\s+/g, " ")} ${b.source}`));
   //     // });
   //   } catch (error) {
   //     console.error("Test OsintSpider failed:", error);
   //   }
   // }
   // testOsintSpider();