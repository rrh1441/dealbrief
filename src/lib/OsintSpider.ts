/* ──────────────────────────────────────────────────────────────────────────
   src/lib/OsintSpider.ts (Adjusted Firecrawl Batching & Timeouts)
   --------------------------------------------------------------------------
   Web-only due diligence with enhanced Firecrawl, ProxyCurl, and LLM-driven insight extraction.
   ------------------------------------------------------------------------ */

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
     throw new Error("CRITICAL ERROR: Missing one or more API keys (SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY, OPENAI_API_KEY).");
   }
   
   /*──────────────────────── CONSTANTS ──────────────────────*/
   const SERPER_API_URL  = "https://google.serper.dev/search";
   const FIRECRAWL_API_URL    = "https://api.firecrawl.dev/v1/scrape";
   const PROXYCURL_API_COMPANY_URL  = "https://nubela.co/proxycurl/api/linkedin/company";
   const PROXYCURL_API_PROFILE_URL  = "https://nubela.co/proxycurl/api/v2/linkedin";
   
   const MAX_SERPER_CALLS   = 600;
   const MAX_SERP_RESULTS_PER_PAGE = 10;
   const MAX_FIRECRAWL_TARGETS     = 50;
   const MAX_PROXYCURL_CALLS     = 10;
       // const FIRECRAWL_BATCH_SIZE   = 15; // Currently unused
   const FIRECRAWL_GLOBAL_BUDGET_MS = 420 * 1000; // UPDATED to 7 minutes for Firecrawl operations
   const MAX_WALL_TIME_MS      = 700 * 1000; // Approx 11.6 minutes total (Vercel limit 720s)
   
   const LLM_MODEL_INSIGHT_EXTRACTION = "gpt-4o-mini";
   const LLM_MODEL_FILE_PREDICTION = "gpt-4o-mini";
   const LLM_MODEL_SUMMARIZATION    = "gpt-4o-mini";
   
   const SECTIONS = ["Corporate","Legal","Cyber","Reputation","Leadership","Financials","Misc"] as const;
   type SectionName = typeof SECTIONS[number];
   
   const MAX_BULLETS_PER_SECTION  = 50;
   const MAX_BULLET_LENGTH  = 500;
   const MAX_TOKENS_EXEC_SUMMARY    = 300;
   const MAX_TOKENS_SECTION_SUMMARY = 160;
   const MAX_TOKENS_FOR_INSIGHT_EXTRACTION_INPUT = 7000;
   const MAX_TOKENS_FOR_INSIGHT_EXTRACTION_OUTPUT = 1000;
   const MAX_TOKENS_FOR_FILE_PREDICTION_OUTPUT = 150;
   const MAX_SOURCES_TO_LLM = 30;
   
   /*─── FIRECRAWL BLACKLIST (User provided + some common additions) ────────*/
   const FIRECRAWL_BLACKLISTED_HOSTNAMES = new Set([
       "linkedin.com", "www.linkedin.com",
       "facebook.com", "www.facebook.com", "m.facebook.com",
       "instagram.com", "www.instagram.com",
       "twitter.com", "x.com", "www.twitter.com", "www.x.com",
       "tiktok.com", "www.tiktok.com",
       "reddit.com", "www.reddit.com", "old.reddit.com",
       "googleusercontent.com",
       "wsj.com", "www.wsj.com",
       "ft.com", "www.ft.com",
       "patreon.com", "www.patreon.com",
       "news.ycombinator.com",
       "apps.dos.ny.gov",
       "yelp.com", "www.yelp.com", "m.yelp.com",
       "nextdoor.com", "www.nextdoor.com",
   ]);
   
   /*──────────────────────── TYPES ──────────────────────────*/
   type Severity = "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"INFO";
   interface ExtractedInsight {
       insightStatement: string; supportingQuote?: string;
       categorySuggestion: SectionName; severitySuggestion: Severity;
       sourceUrl: string; citationMarker?: string;
   }
       export interface ReportBullet {
        text: string; quote?: string; sourceUrl: string;
        citationMarker: string; severity: Severity;
        origin: 'llm_insight' | 'heuristic_snippet' | 'file_placeholder' | 'proxycurl_summary';
        llmSuggestedCategory?: SectionName;
    }
       export interface SectionOutput  { name:SectionName; summary:string; bullets:ReportBullet[] }
       export interface Citation { marker:string; url:string; title:string; snippet:string }
   interface SerperOrganicResult { title:string; link:string; snippet?:string; position?: number; }
   interface SerperResponse    { organic?:SerperOrganicResult[] }
   interface FirecrawlScrapeV1Result {
       success: boolean;
       data?: {
           content: string; markdown: string; text_content: string;
           metadata: Record<string, string | number | boolean | undefined | null>;
           article?: { title?: string; author?: string; publishedDate?: string; text_content?: string; };
       };
       error?: string; status?: number;
   }
   interface YearMonthDay { year?: number; month?: number; day?: number }
   interface LinkedInExperience { company?: string; title?: string; starts_at?: YearMonthDay; ends_at?: YearMonthDay; description?: string; }
   interface ProxyCurlCommon {
       linkedin_profile_url?: string; linkedin_company_profile_url?: string;
       [key: string]: unknown;
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
       headquarters?: { city: string; state: string; country: string; };
   }
       export interface FileForManualReview {
        url: string; title: string; serpSnippet: string;
        predictedInterest: string; citationMarker: string;
    }
   export interface OsintSpiderPayload {
     company:string; domain:string; generated:string;
     summary:string; sections:SectionOutput[]; citations:Citation[];
     filesForManualReview: FileForManualReview[];
     cost:{ serper:number; firecrawl:number; proxycurl:number; llm:number; total:number };
     stats: {
       serperQueries: number; serperResultsProcessed: number;
       firecrawlTargets: number; firecrawlAttempts: number; firecrawlSuccesses: number;
       pagesForDeepAnalysis: number; llmInsightExtractionCalls: number; llmSummarizationCalls: number; llmFilePredictionCalls: number;
       totalLlmInputTokens: number; totalLlmOutputTokens: number;
       proxycurlCalls: number; wallTimeSeconds: number;
     };
   }
   
   /*────────────────────── INPUT SCHEMA ───────────────────*/
   const osintSpiderInputSchema = z.object({
     company_name: z.string().trim().min(1),
     domain:       z.string().trim().min(3).refine(val => /\./.test(val), "Domain must contain a dot."),
     owner_names:  z.array(z.string().trim().min(1)).optional(),
   });
   
   /*──────────────────────── HELPERS ───────────────────────*/
   const truncateText  = (s:string,n:number):string => (s || "").length<=n? (s || "") : (s || "").slice(0,n-1)+"…";
   const estimateTokens = (s:string):number => Math.ceil((s || "").length / 3.5);
   
   const INPUT_TOKEN_PRICE_PER_MILLION = 0.15;
   const OUTPUT_TOKEN_PRICE_PER_MILLION = 0.60;
   const calculateLlmCallCost = (inputTokens:number, outputTokens:number): number =>
     (inputTokens / 1_000_000 * INPUT_TOKEN_PRICE_PER_MILLION) +
     (outputTokens / 1_000_000 * OUTPUT_TOKEN_PRICE_PER_MILLION);
   
   const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
   let totalLlmInputTokens = 0; let totalLlmOutputTokens = 0;
   let llmInsightExtractionCalls = 0; let llmSummarizationCalls = 0; let llmFilePredictionCalls = 0;
   
   async function callLlmApi(
       prompt: string, systemMessage: string, model: string,
       maxOutputTokens: number, temperature: number = 0.2
   ): Promise<string | null> {
       const currentInputTokens = estimateTokens(prompt) + estimateTokens(systemMessage);
       totalLlmInputTokens += currentInputTokens;
       try {
           const response = await ai.chat.completions.create({
               model: model, messages: [{ role: "system", content: systemMessage }, { role: "user", content: prompt }],
               temperature: temperature, max_tokens: maxOutputTokens,
           });
           const content = response.choices[0]?.message?.content;
           totalLlmOutputTokens += response.usage?.completion_tokens ?? estimateTokens(content || "");
           return content || null;
       } catch (error: unknown) {
           const err = error instanceof Error ? error : new Error(String(error));
           console.error(`[LLM Call Error] Model: ${model}, Error: ${err.message}`, err.stack ? err.stack.slice(0, 500) : "");
           return null;
       }
   }
   
   const postJSON = async <T>(
     url: string, body: unknown, headers: Record<string, string>, method: "POST" | "GET" = "POST",
   ): Promise<T> => {
     const options: RequestInit = { method, headers: { ...headers, "Content-Type": "application/json" } };
     if (method === "POST") options.body = JSON.stringify(body);
     const response: FetchResponse = await fetch(url, options);
     if (!response.ok) {
       const errorBodyText = await response.text();
       const errorMessage = `HTTP ${response.status} for ${url} – ${truncateText(errorBodyText, 200)}`;
       console.error(`postJSON Error: ${errorMessage}`);
       throw new Error(errorMessage);
     }
     const responseText = await response.text();
     try {
       const parsedJson: unknown = JSON.parse(responseText);
       return parsedJson as T;
     } catch (e: unknown) {
       const err = e instanceof Error ? e : new Error(String(e));
       const parseErrorMessage = `Failed to parse JSON response from ${url}: ${err.message}. Response text snippet: ${truncateText(responseText,200)}`;
       console.error(`postJSON: ${parseErrorMessage}`);
       throw new Error(parseErrorMessage);
     }
   };
   
   /* ── Firecrawl with Enhanced Logging, 403 Handling, and Blacklist───── */
   let firecrawlGlobalAttempts = 0; let firecrawlGlobalSuccesses = 0;
   const dynamicallyUnsupportedFirecrawlSites = new Set<string>();
   
   const firecrawlWithLogging = async (url: string, attemptInfoForLogs: string): Promise<string | null> => {
     const urlHostname = (() => { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ""; } })();
   
     if (urlHostname && (FIRECRAWL_BLACKLISTED_HOSTNAMES.has(urlHostname) || dynamicallyUnsupportedFirecrawlSites.has(urlHostname))) {
       console.log(`[Firecrawl Skip] ${attemptInfoForLogs} - URL: ${url} - Hostname '${urlHostname}' is blacklisted or previously flagged unsupported.`);
       return null;
     }
   
     firecrawlGlobalAttempts++;
     const tryScrapeOnce = async (timeoutMs: number): Promise<string | null> => {
       try {
         console.log(`[Firecrawl Attempt] ${attemptInfoForLogs} - URL: ${url}, Timeout: ${timeoutMs}ms`);
         const response = await Promise.race([
           postJSON<FirecrawlScrapeV1Result>(FIRECRAWL_API_URL, { url }, { Authorization: `Bearer ${FIRECRAWL_KEY!}` }),
           new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)),
         ]);
         if (response && response.success && response.data?.article && typeof response.data.article.text_content === 'string' && response.data.article.text_content.trim() !== "") {
           firecrawlGlobalSuccesses++; return response.data.article.text_content;
         } else if (response && response.success && response.data && (response.data.text_content || response.data.markdown)) {
            const fallbackText = response.data.text_content || response.data.markdown;
            if (fallbackText && typeof fallbackText === 'string' && fallbackText.trim() !== "") {
               console.warn(`[Firecrawl PartialSuccess] ${attemptInfoForLogs} - URL: ${url}. No article.text_content, using generic text/markdown (length: ${fallbackText.length}).`);
               firecrawlGlobalSuccesses++; return fallbackText;
            }
         }
         if (response && !response.success) {
           console.error(`[Firecrawl API Error] ${attemptInfoForLogs} - URL: ${url}. Error: ${response.error || 'Unknown Firecrawl error'}. Status: ${response.status || 'N/A'}`);
           if (response.status === 403 && response.error?.includes("website is no longer supported")) {
             if (urlHostname) dynamicallyUnsupportedFirecrawlSites.add(urlHostname);
             console.warn(`[Firecrawl Unsupported] Added '${urlHostname}' to dynamic no-scrape list for this run.`);
             return "SITE_UNSUPPORTED_BY_FIRECRAWL";
           }
         } else console.warn(`[Firecrawl NoContentOrOddResponse] ${attemptInfoForLogs} - URL: ${url}. Resp: ${JSON.stringify(response).slice(0,300)}`);
         return null;
       } catch (error: unknown) {
         const err = error instanceof Error ? error : new Error(String(error));
         if (err.message.includes("HTTP 403") && err.message.includes("website is no longer supported")) {
             if (urlHostname) dynamicallyUnsupportedFirecrawlSites.add(urlHostname);
             console.warn(`[Firecrawl Unsupported via Exception] Added '${urlHostname}' to dynamic no-scrape list. Error: ${err.message}`);
             return "SITE_UNSUPPORTED_BY_FIRECRAWL";
         }
         // Check for timeout specifically
         if (err.message.toLowerCase().includes("timeout")) {
              console.warn(`[Firecrawl TimeoutCaught] ${attemptInfoForLogs} - URL: ${url}, Timeout: ${timeoutMs}ms. Error: ${err.message}`);
         } else {
              console.error(`[Firecrawl Exception] ${attemptInfoForLogs} - URL: ${url}, Timeout: ${timeoutMs}ms. Error: ${err.message}`);
         }
         return null;
       }
     };
     // UPDATED Timeouts
     let content = await tryScrapeOnce(25000); // Initial attempt with 25s
     if (content === "SITE_UNSUPPORTED_BY_FIRECRAWL") return null;
   
     if (content === null) {
       console.warn(`[Firecrawl Retry] First attempt failed for ${url} (${attemptInfoForLogs}). Retrying.`);
       content = await tryScrapeOnce(40000); // Retry with 40s
       if (content === null) console.error(`[Firecrawl FailedAllAttempts] URL: ${url} (${attemptInfoForLogs}).`);
     }
     return content === "SITE_UNSUPPORTED_BY_FIRECRAWL" ? null : content;
   };
   
   /*──────────────────────── REGEX & SCORING HELPERS ────────────────*/
   const RISK_WORDS_OS = /\b(breach|leak|ransom|hack|exposed data|vulnerability|security incident|cyberattack|fraud|scandal|lawsuit|litigation|complaint|sec filing|investigation|fine|penalty|illegal|unethical|corruption|bribery|money laundering|sanction|recall|unsafe|defect|warning letter|regulatory action|insolvency|bankruptcy|default|liquidation|receivership|cease and desist)\b/i;
   const FILE_EXTENSIONS_REGEX = /\.(pdf|xlsx?|docx?|csv|txt|log|sql|bak|zip|tar\.gz|tgz)$/i;
   
   const scoreSerpResultInitial = (r:SerperOrganicResult, domain:string, targetedKeywords: string[] = []):number => {
     let s=0.1; const snippet = (r.snippet || "").toLowerCase(); const title = (r.title || "").toLowerCase();
     if(r.link.includes(domain)) s+=0.2;
     if (targetedKeywords.some(kw => snippet.includes(kw) || title.includes(kw))) s += 0.3;
     if(RISK_WORDS_OS.test(snippet) || RISK_WORDS_OS.test(title)) s+=0.25;
     if(r.link.match(FILE_EXTENSIONS_REGEX)) s += 0.1;
     if(r.link.includes("sec.gov") || r.link.includes("courtlistener.com") || r.link.includes("pacer.gov") || r.link.includes("justice.gov")) s += 0.2;
     if(r.link.includes("news.") || r.link.includes("/news") || r.link.includes("prnewswire") || r.link.includes("reuters.com") || r.link.includes("bloomberg.com") || r.link.includes("wsj.com")) s += 0.15;
     return Math.min(1.0, s);
   };
   
   /*───────────────── EXPANDED TARGETED DORKS (Each OR term becomes a query) ──*/
   const getTargetedDorksExpanded = (companyCanon: string, domain: string, ownerNames: string[] = []) => {
     const expandedDorks: {query: string, type: string, priority: number}[] = [];
     const companyOrDomain = `("${companyCanon}" OR "${domain}")`;
     const companyOnly = `"${companyCanon}"`;
   
     const baseDorkGroups: {prefix: string, keywords: string[], type: SectionName | "GeneralRisk", priority: number, suffix?: string}[] = [
       // Legal & Regulatory
       { prefix: companyOrDomain, keywords: ["lawsuit", "litigation", "court case", "legal action", "settlement", "class action"], type: "Legal", priority: 10 },
       { prefix: companyOrDomain, keywords: ["site:sec.gov", '"sec filing"', '"10-K"', '"10-Q"', '"form 4"'], type: "Financials", priority: 10 },
       { prefix: companyOnly, keywords: ["fine", "penalty", "sanction", '"regulatory action"', "investigation"], type: "Legal", priority: 9 },
       // Cyber & Data Breaches
       { prefix: companyOrDomain, keywords: ['"data breach"', '"cyber attack"', "hacked", '"vulnerability disclosed"', '"security incident"', "ransomware"], type: "Cyber", priority: 10 },
       { prefix: companyOrDomain, keywords: ['"exposed database"', '"leaked credentials"', '"api key leak"'], type: "Cyber", priority: 9 },
       // Cyber - Specific Sites
       { prefix: `site:pastebin.com (${companyOrDomain})`, keywords: [""], type: "Cyber", priority: 8 },
       { prefix: `site:ghostbin.com (${companyOrDomain})`, keywords: [""], type: "Cyber", priority: 8 },
       { prefix: `site:plaintext.in (${companyOrDomain})`, keywords: [""], type: "Cyber", priority: 8 },
       { prefix: `site:github.com (${companyOrDomain})`, keywords: ["password", "secret", "apikey", '"config leak"', '"database dump"'], type: "Cyber", priority: 8 },
       // Negative Reputation
       { prefix: companyOnly, keywords: ["scandal", "controversy", "fraud", "misconduct", "unethical", "protest", "boycott", '"consumer complaints"'], type: "Reputation", priority: 9 },
       { prefix: `${companyOnly} reviews`, keywords: ["complaint", '"negative feedback"', '"poor service"', "issue", "problem", '"1 star"'], type: "Reputation", priority: 8, suffix: ` -site:${domain}` },
       // Corporate & Financials
       { prefix: companyOnly, keywords: ['"acquisition of"', '"merger with"', '"acquired by"', '"invested in"', '"partnership with"', '"joint venture"'], type: "Corporate", priority: 7 },
       { prefix: companyOnly, keywords: ['"financial results"', "earnings", '"annual report"', '"investor relations"', '"funding round"'], type: "Financials", priority: 7, suffix: " filetype:pdf" },
       { prefix: companyOnly, keywords: ["layoffs", '"restructuring"', '"chapter 11"', "bankruptcy", "insolvency", '"store closures"'], type: "Corporate", priority: 8 },
     ];
   
     baseDorkGroups.forEach(group => {
       group.keywords.forEach(keyword => {
         // If keyword is empty (for site-only searches), don't add an extra space
         let queryString = keyword ? `${group.prefix} ${keyword}`.trim() : group.prefix.trim();
         if (group.suffix) queryString += group.suffix;
         expandedDorks.push({ query: queryString, type: group.type as SectionName, priority: group.priority });
       });
     });
   
     expandedDorks.push({ query: `"${companyCanon}"`, type: "Corporate", priority: 5 });
     expandedDorks.push({ query: `"${companyCanon}" site:${domain}`, type: "Corporate", priority: 4 });
   
     ownerNames.forEach(owner => {
       const ownerRiskKeywords = ["fraud", "lawsuit", "investigation", "scandal", "controversy", '"insider trading"'];
       ownerRiskKeywords.forEach(keyword => {
           expandedDorks.push({ query: `"${owner}" "${companyCanon}" ${keyword}`, type: "Leadership", priority: 9 });
       });
       expandedDorks.push({ query: `"${owner}" "${companyCanon}"`, type: "Leadership", priority: 6 });
     });
     return expandedDorks;
   };
   
   /*───────────────── PHASE 2 (New): Smarter Scraping Target Selection ──────────────────*/
   interface PrioritizedSerpResult extends SerperOrganicResult {
       initialScore: number;
       dorkType: string;
       priorityForScraping: number;
   }
   
   function selectTopScrapingTargets(
       allSerpHitsWithDorkTypeInput: {hit: SerperOrganicResult, dorkType: string}[],
       companyCanon: string, domain: string,
       maxTargets: number
   ): PrioritizedSerpResult[] {
       const scoredWithDetails: PrioritizedSerpResult[] = [];
       const riskKeywords = (typeof RISK_WORDS_OS.source === 'string')
           ? RISK_WORDS_OS.source.replace(/\\b/g, '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean)
           : [];
   
       allSerpHitsWithDorkTypeInput.forEach(({hit, dorkType}) => {
           let priority = 1;
           const snippet = (hit.snippet || "").toLowerCase();
           const title = (hit.title || "").toLowerCase();
           const link = hit.link.toLowerCase();
   
           if (RISK_WORDS_OS.test(snippet) || RISK_WORDS_OS.test(title)) priority += 5;
           if (dorkType === "Legal" || dorkType === "Cyber" || dorkType === "Financials") priority +=3;
           if (link.includes("sec.gov") || link.includes("courtlistener.com") || link.includes("justice.gov")) priority += 4;
           if (link.match(FILE_EXTENSIONS_REGEX)) priority +=2;
           if (link.includes("news.") || link.includes("/news") || link.includes("reuters.com") || link.includes("bloomberg.com") || link.includes("wsj.com")) priority +=3;
           if (link.includes(domain) && !(link.includes("/blog") || link.includes("/news") || link.includes("/press"))) priority -=2;
   
           const currentInitialScore = scoreSerpResultInitial(hit, domain, riskKeywords);
           scoredWithDetails.push({
               ...hit,
               initialScore: currentInitialScore,
               dorkType: dorkType,
               priorityForScraping: priority + (currentInitialScore * 5)
           });
       });
   
       scoredWithDetails.sort((a, b) => b.priorityForScraping - a.priorityForScraping);
       const uniqueTargets = Array.from(new Map(scoredWithDetails.map(item => [item.link, item])).values());
       return uniqueTargets.slice(0, maxTargets);
   }
   
   /*───────────────── PHASE 3 (New): Insight Extraction from Page Text ──────────────────*/
   async function extractInsightsFromPage(
       fullText: string, sourceUrl: string, companyCanon: string,
       domain: string, ownerNames: string[] = []
   ): Promise<ExtractedInsight[]> {
       llmInsightExtractionCalls++;
       const systemMessage = `You are an expert OSINT analyst tasked with extracting actionable due diligence insights about "${companyCanon}" from provided web page text. Focus on factual statements, potential risks, or significant corporate information. Be objective.`;
       const prompt = `
   CONTEXT: Text from URL: ${sourceUrl}. Analysis for: "${companyCanon}" (domain: ${domain}). Owners/key personnel: ${ownerNames.join(", ") || "N/A"}.
   
   TEXT_TO_ANALYZE (first ${MAX_TOKENS_FOR_INSIGHT_EXTRACTION_INPUT} tokens):
   ---
   ${truncateText(fullText, MAX_TOKENS_FOR_INSIGHT_EXTRACTION_INPUT * 3.5)}
   ---
   INSTRUCTIONS:
   Based ONLY on TEXT_TO_ANALYZE:
   1. Identify up to 5 distinct, specific, actionable due diligence findings for "${companyCanon}".
   2. For each finding, provide:
       a. "insightStatement": Concise summary of the finding (1-2 sentences). Must directly relate to "${companyCanon}".
       b. "supportingQuote": Brief, EXACT quote from text supporting the statement (max 60 words). If no direct quote, describe the evidence from the text.
       c. "categorySuggestion": Suggest the most appropriate category from this list: ${SECTIONS.join(", ")}.
       d. "severitySuggestion": Suggest a severity from this list: CRITICAL, HIGH, MEDIUM, LOW, INFO. Base this on potential impact.
   3. If no specific due diligence findings are present, return an empty array.
   4. Format your entire response as a valid JSON array of finding objects. Example of a single object: {"insightStatement":"...", "supportingQuote":"...", "categorySuggestion":"Legal", "severitySuggestion":"HIGH", "sourceUrl":"${sourceUrl}"}
      Ensure the entire response is ONLY the JSON array. Do not include any explanatory text, apologies, or markdown backticks (like \`\`\`json or \`\`\`) around the JSON.`;
   
       const llmResponse = await callLlmApi(prompt, systemMessage, LLM_MODEL_INSIGHT_EXTRACTION, MAX_TOKENS_FOR_INSIGHT_EXTRACTION_OUTPUT, 0.1);
   
       if (llmResponse) {
           try {
               let cleanJsonResponse = llmResponse.trim();
               const jsonMatch = cleanJsonResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
               if (jsonMatch && jsonMatch[1]) {
                   cleanJsonResponse = jsonMatch[1].trim();
               } else if (cleanJsonResponse.startsWith("```") && cleanJsonResponse.endsWith("```")) {
                    cleanJsonResponse = cleanJsonResponse.substring(3, cleanJsonResponse.length - 3).trim();
               }
               
               if (!cleanJsonResponse.startsWith("[") || !cleanJsonResponse.endsWith("]")) {
                   if (cleanJsonResponse.startsWith("{") && cleanJsonResponse.endsWith("}")) {
                       console.warn(`[LLM InsightParseWarn] LLM returned single object, wrapping in array for ${sourceUrl}. Resp: ${cleanJsonResponse.slice(0,100)}`);
                       cleanJsonResponse = `[${cleanJsonResponse}]`;
                   } else if (cleanJsonResponse.toLowerCase() === "[]" || cleanJsonResponse.toLowerCase() === "null" || cleanJsonResponse.trim() === "" ) {
                       // Handle cases where LLM explicitly says no findings with empty array string
                       console.log(`[LLM InsightInfo] LLM indicated no specific findings for ${sourceUrl}.`);
                       return [];
                   }
                   else {
                       console.error(`[LLM InsightParseError] Cleaned response is not a JSON array for ${sourceUrl}. Cleaned Resp: ${cleanJsonResponse.slice(0,200)}`);
                       return [];
                   }
               }
               
               const parsedUnknown: unknown = JSON.parse(cleanJsonResponse);
               if (Array.isArray(parsedUnknown)) {
                   const parsed = parsedUnknown as Partial<ExtractedInsight>[];
                   return parsed.map(p => ({
                       insightStatement: p.insightStatement || "N/A",
                       supportingQuote: p.supportingQuote,
                       categorySuggestion: SECTIONS.includes(p.categorySuggestion as SectionName) ? p.categorySuggestion as SectionName : "Misc",
                       severitySuggestion: ["CRITICAL","HIGH","MEDIUM","LOW","INFO"].includes(p.severitySuggestion as Severity) ? p.severitySuggestion as Severity : "INFO",
                       sourceUrl: sourceUrl,
                   })).filter(p => p.insightStatement !== "N/A");
               } else {
                    console.error(`[LLM InsightParseError] Expected array after parsing, got ${typeof parsedUnknown} for ${sourceUrl}. Cleaned LLM Response: ${cleanJsonResponse.slice(0,200)}`);
               }
           } catch (e: unknown) {
               const err = e instanceof Error ? e : new Error(String(e));
               console.error(`[LLM InsightParseError] Failed to parse insights for ${sourceUrl}. Error: ${err.message}. Original LLM Response: ${llmResponse.slice(0,500)}`);
           }
       }
       return [];
   }
   
   /*───────────────── PHASE 3.5 (New): File Prediction Logic ──────────────────*/
   async function predictFileInterest(
       url: string, title: string, serpSnippet: string, companyCanon: string
   ): Promise<string> {
       llmFilePredictionCalls++;
       const systemMessage = `You are an OSINT analyst predicting the potential due diligence interest of a linked file for company "${companyCanon}".`;
       const prompt = `
   File URL: ${url}
   File Title: ${title || "N/A"}
   SERP Snippet: ${serpSnippet || "N/A"}
   Based on this metadata, what is the *potential* due diligence interest of this file regarding "${companyCanon}"?
   Examples: "Potential financial report," "Possible contract template," "Government filing," "Technical specification sheet," "List of vendors/clients," "Unknown public data record."
   Be brief (1 phrase/sentence). If interest is unclear, state "Unclear interest from metadata."`;
       const prediction = await callLlmApi(prompt, systemMessage, LLM_MODEL_FILE_PREDICTION, MAX_TOKENS_FOR_FILE_PREDICTION_OUTPUT, 0.3);
       return prediction || "Prediction failed or unclear interest.";
   }
   
   /*──────────────────────── MAIN OsintSpider Function ──────────────────────*/
   export async function runOsintSpider(rawInput:unknown):Promise<OsintSpiderPayload>{
     const t0 = performance.now();
     firecrawlGlobalAttempts = 0; firecrawlGlobalSuccesses = 0;
     totalLlmInputTokens = 0; totalLlmOutputTokens = 0;
     llmInsightExtractionCalls = 0; llmSummarizationCalls = 0; llmFilePredictionCalls = 0;
     let serperQueries = 0; let serperResultsProcessed = 0;
     let proxycurlCalls = 0;
     dynamicallyUnsupportedFirecrawlSites.clear();
   
     const { company_name, domain, owner_names=[] } = osintSpiderInputSchema.parse(rawInput);
     const companyCanon = company_name.toLowerCase()
       .replace(/[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,"")
       .replace(/[.,']/g,"").trim();
   
     const bulletsBySection:Record<SectionName,ReportBullet[]> = SECTIONS.reduce((acc, sec) => ({...acc, [sec]: []}), {} as Record<SectionName,ReportBullet[]>);
     const citationsList:Citation[]=[];
     const filesForManualReviewList: FileForManualReview[] = [];
     const processedUrlsForDeepAnalysis = new Set<string>();
   
     /*──── PHASE 1: SERPER BFS & Dorking ────*/
     console.log(`[OsintSpider] Phase 1: Starting SERPER BFS for "${companyCanon}"`);
     const dorks = getTargetedDorksExpanded(companyCanon, domain, owner_names);
     const allSerpHitsWithDorkType: {hit: SerperOrganicResult, dorkType: string}[] = [];
     const initialHitLinks = new Set<string>();
   
     for (const dorkInfo of dorks) {
       if (performance.now() - t0 > MAX_WALL_TIME_MS * 0.4 || serperQueries >= MAX_SERPER_CALLS) {
           console.warn("[OsintSpider] Time or call budget for SERP phase reached. Stopping SERP queries.");
           break;
       }
       console.log(`[OsintSpider] Serper Query (Type: ${dorkInfo.type}, Prio: ${dorkInfo.priority}): ${truncateText(dorkInfo.query, 150)}`);
       try {
         const serperResponse = await postJSON<SerperResponse>(
           SERPER_API_URL,{q:dorkInfo.query,num:MAX_SERP_RESULTS_PER_PAGE,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!});
         serperQueries++;
         (serperResponse.organic || []).forEach(hit => {
             const canonicalLink = hit.link?.replace(/(\?|#).*/,"");
             if (canonicalLink && !initialHitLinks.has(canonicalLink)) {
                 allSerpHitsWithDorkType.push({hit: {...hit, snippet: hit.snippet || hit.title || ""}, dorkType: dorkInfo.type});
                 initialHitLinks.add(canonicalLink);
             }
         });
       } catch (e:unknown) {
           const err = e instanceof Error ? e : new Error(String(e));
           console.warn(`[OsintSpider] Serper call failed for dork "${truncateText(dorkInfo.query,100)}". Error: ${err.message}`);
       }
     }
     serperResultsProcessed = allSerpHitsWithDorkType.length;
     console.log(`[OsintSpider] Serper BFS finished. ${serperResultsProcessed} initial hits from ${serperQueries} queries.`);
   
     /*──── PHASE 1.5: ProxyCurl Enrichment ────*/
     if (PROXYCURL_KEY) {
       console.log(`[OsintSpider] Phase 1.5: Starting ProxyCurl enrichment.`);
       const companyLinkedInHitResult = allSerpHitsWithDorkType.find(({hit}) => hit.link.includes("linkedin.com/company/"));
       if (companyLinkedInHitResult && proxycurlCalls < MAX_PROXYCURL_CALLS) {
           const companyLinkedInHit = companyLinkedInHitResult.hit;
           try {
               const companyUrl = `${PROXYCURL_API_COMPANY_URL}?url=${encodeURIComponent(companyLinkedInHit.link)}&fallback_to_cache=on-error&use_cache=if-present`;
               const companyData = await postJSON<ProxyCurlCompanyResult>(companyUrl, {}, { Authorization: `Bearer ${PROXYCURL_KEY!}` }, "GET");
               proxycurlCalls++;
               if (companyData) {
                   const enrichedSnippet = `Industry: ${companyData.industry || "N/A"}, Founded: ${companyData.founded_year || "N/A"}. ${truncateText(companyData.description || "", 150)}`;
                   const existingHitIndex = allSerpHitsWithDorkType.findIndex(h => h.hit.link === companyLinkedInHit.link);
                   const newHitData = { title: companyData.name || companyLinkedInHit.title, link: companyLinkedInHit.link, snippet: enrichedSnippet, position: -1 };
                   if (existingHitIndex !== -1) {
                       allSerpHitsWithDorkType[existingHitIndex].hit = { ...allSerpHitsWithDorkType[existingHitIndex].hit, ...newHitData };
                   } else {
                        allSerpHitsWithDorkType.unshift({ hit: newHitData, dorkType: "ProxyCurl_Company"});
                   }
                   console.log(`[OsintSpider] Enriched company profile: ${companyLinkedInHit.link}`);
               }
                       } catch { /* error logged by postJSON */ }
       }
   
       const ownersToEnrich = owner_names.slice(0, Math.min(3, MAX_PROXYCURL_CALLS - proxycurlCalls));
       for (const ownerName of ownersToEnrich) {
           if (proxycurlCalls >= MAX_PROXYCURL_CALLS) break;
           let ownerLinkedInUrl: string | undefined;
                       const ownerSerpHitObj = allSerpHitsWithDorkType.find(({hit}) =>
                hit.link.includes("linkedin.com/in/") && ( (hit.title||"").toLowerCase().includes(ownerName.toLowerCase()) || (hit.snippet||"").toLowerCase().includes(ownerName.toLowerCase()))
            );
           let ownerSerpHit: SerperOrganicResult | undefined = ownerSerpHitObj?.hit;
   
           if (!ownerSerpHit) {
               console.log(`[OsintSpider] Serper searching for LinkedIn profile for owner: ${ownerName}`);
               try {
                   const serperOwnerResp = await postJSON<SerperResponse>(SERPER_API_URL,
                     {q:`"${ownerName}" "${companyCanon}" "linkedin.com/in/" site:linkedin.com`,num:1,gl:"us",hl:"en"},{"X-API-KEY":SERPER_KEY!});
                   serperQueries++;
                   if(serperOwnerResp.organic && serperOwnerResp.organic.length > 0 && serperOwnerResp.organic[0].link) {
                       ownerSerpHit = serperOwnerResp.organic[0];
                       ownerLinkedInUrl = ownerSerpHit.link;
                       if (ownerLinkedInUrl && !allSerpHitsWithDorkType.some(h => h.hit.link === ownerLinkedInUrl)) { // Check if URL is valid string
                           allSerpHitsWithDorkType.unshift({ hit: {...ownerSerpHit, snippet: ownerSerpHit.snippet || ownerSerpHit.title || "" }, dorkType: "ProxyCurl_Owner_Search"});
                       }
                   }
                               } catch { /* error logged by postJSON */ }
           } else {
               ownerLinkedInUrl = ownerSerpHit.link;
           }
   
           if (ownerLinkedInUrl && proxycurlCalls < MAX_PROXYCURL_CALLS) {
               console.log(`[OsintSpider] Enriching owner profile via ProxyCurl: ${ownerName} - ${ownerLinkedInUrl}`);
               try {
                   const profileUrl = `${PROXYCURL_API_PROFILE_URL}?url=${encodeURIComponent(ownerLinkedInUrl)}&fallback_to_cache=on-error&use_cache=if-present`;
                   const profileData = await postJSON<ProxyCurlProfileResult>(profileUrl, {}, {Authorization:`Bearer ${PROXYCURL_KEY!}`}, "GET");
                   proxycurlCalls++;
                   if (profileData) {
                       const enrichedSnippet = `${profileData.full_name || ownerName} - ${profileData.headline || "Headline N/A"}. ${truncateText(profileData.summary || "", 100)}`;
                       const existingHitIndex = allSerpHitsWithDorkType.findIndex(h => h.hit.link === ownerLinkedInUrl);
                       const newHitData = { title: profileData.full_name || ownerName, link: ownerLinkedInUrl, snippet: enrichedSnippet, position: -1 };
                       if (existingHitIndex !== -1) {
                           allSerpHitsWithDorkType[existingHitIndex].hit = { ...allSerpHitsWithDorkType[existingHitIndex].hit, ...newHitData };
                       } else {
                           allSerpHitsWithDorkType.unshift({ hit: newHitData, dorkType: "ProxyCurl_Owner"});
                       }
                       console.log(`[OsintSpider] Enriched owner profile for ${ownerName}.`);
                   }
               } catch (e: unknown) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    console.warn(`[OsintSpider] ProxyCurl profile enrichment for ${ownerName} (${ownerLinkedInUrl}) failed. Error: ${err.message}`);
               }
           }
       }
     } else {
       console.warn("[OsintSpider] Phase 1.5: Skipped ProxyCurl enrichment - PROXYCURL_KEY not set.");
     }
     console.log(`[OsintSpider] ProxyCurl enrichment finished. ${proxycurlCalls} calls made.`);
   
     /*──── PHASE 2: Select Top Scraping Targets ────*/
     console.log(`[OsintSpider] Phase 2: Selecting top targets for scraping from ${allSerpHitsWithDorkType.length} hits.`);
     const prioritizedScrapingTargets = selectTopScrapingTargets(
         allSerpHitsWithDorkType,
         companyCanon, domain, MAX_FIRECRAWL_TARGETS
       );
     console.log(`[OsintSpider] Selected ${prioritizedScrapingTargets.length} targets for Firecrawl.`);
   
     /*──── PHASE 3: Firecrawl & Insight Extraction / File Flagging ────*/
     console.log(`[OsintSpider] Phase 3: Starting Firecrawl & Insight Extraction for ${prioritizedScrapingTargets.length} targets.`);
     const firecrawlPhaseStartTime = performance.now();
   
     for (const hit of prioritizedScrapingTargets) {
       if (performance.now() - firecrawlPhaseStartTime > FIRECRAWL_GLOBAL_BUDGET_MS ||
           performance.now() - t0 > MAX_WALL_TIME_MS * 0.9) { // Adjusted to 90% to leave more time for final summaries
         console.warn("[OsintSpider] Time budget for Firecrawl/Insight Extraction phase reached. Stopping early.");
         break;
       }
   
       const citationNumber = citationsList.length + 1;
       citationsList.push({
           marker:`[${citationNumber}]`, url:hit.link, title:hit.title || "Untitled", // Ensure title is not undefined
           snippet:truncateText(hit.snippet || hit.title || "", 250)
       });
   
       const isFile = hit.link.match(FILE_EXTENSIONS_REGEX);
       if (isFile) {
           const predictedInterest = await predictFileInterest(hit.link, hit.title || "Untitled", hit.snippet || "", companyCanon);
           filesForManualReviewList.push({
               url: hit.link, title: hit.title || "Untitled", serpSnippet: hit.snippet || "",
               predictedInterest, citationMarker: `[${citationNumber}]`
           });
           console.log(`[OsintSpider] File flagged: ${hit.link} - Interest: ${predictedInterest} ${`[${citationNumber}]`}`);
           continue;
       }
   
       if (processedUrlsForDeepAnalysis.has(hit.link)) continue;
   
       const attemptInfo = `OsintSpider Target ${processedUrlsForDeepAnalysis.size + 1}/${prioritizedScrapingTargets.length}`;
       const scrapedText = await firecrawlWithLogging(hit.link, attemptInfo);
       processedUrlsForDeepAnalysis.add(hit.link);
   
       if (scrapedText && scrapedText.length > 150) {
           console.log(`[OsintSpider] Extracting insights from: ${hit.link} (Length: ${scrapedText.length})`);
           const insights = await extractInsightsFromPage(scrapedText, hit.link, companyCanon, domain, owner_names);
           insights.forEach(insight => {
               const section = insight.categorySuggestion;
               if (bulletsBySection[section].length < MAX_BULLETS_PER_SECTION) {
                   bulletsBySection[section].push({
                       text: insight.insightStatement,
                       quote: insight.supportingQuote,
                       sourceUrl: insight.sourceUrl,
                       citationMarker: `[${citationNumber}]`,
                       severity: insight.severitySuggestion,
                       origin: 'llm_insight',
                       llmSuggestedCategory: insight.categorySuggestion
                   });
               }
           });
       } else if (hit.snippet && hit.snippet.length > 70) {
           console.log(`[OsintSpider] Using SERP snippet for: ${hit.link} (Scrape fail/short text)`);
           const section = "Misc";
            if (bulletsBySection[section].length < MAX_BULLETS_PER_SECTION) {
               bulletsBySection[section].push({
                   text: truncateText(hit.snippet, MAX_BULLET_LENGTH),
                   sourceUrl: hit.link,
                   citationMarker: `[${citationNumber}]`,
                   severity: RISK_WORDS_OS.test(hit.snippet.toLowerCase()) ? "MEDIUM" : "LOW",
                   origin: 'heuristic_snippet'
               });
           }
       }
     }
     const pagesForDeepAnalysisCount = processedUrlsForDeepAnalysis.size - filesForManualReviewList.length;
     console.log(`[OsintSpider] Phase 3 finished. Deep analysis on up to ${pagesForDeepAnalysisCount} pages. Files for review: ${filesForManualReviewList.length}.`);
   
     /*──── PHASE 4: LLM Summaries ────*/
     console.log(`[OsintSpider] Phase 4: Generating LLM section and executive summaries.`);
     llmSummarizationCalls = 0;
   
     const sectionsOutput:SectionOutput[] = await Promise.all(SECTIONS.map(async sectionName=>{
       const currentBullets=bulletsBySection[sectionName];
       if(!currentBullets.length) return {name:sectionName,summary:"No specific findings were identified for this section from the analyzed web data.",bullets:[]};
   
       llmSummarizationCalls++;
       const contextForLlm = currentBullets.slice(0, 20)
           .map(b=>`- Finding: ${b.text}${b.quote ? ` (Evidence: "${truncateText(b.quote, 80)}")` : ''} (Severity: ${b.severity}, Source: ${b.citationMarker})`)
           .join("\n");
       const summaryPrompt = `Summarize the key themes and most impactful information for the "${sectionName}" section regarding "${companyCanon}", based ONLY on the following findings. Mention significant risk levels or patterns if apparent. Be concise (2-4 sentences). Findings:\n${contextForLlm}`;
       const systemPrompt = "You are a due diligence analyst writing a section summary. Be objective and factual. If findings are sparse or minor, reflect that.";
   
       const summaryText = await callLlmApi(summaryPrompt, systemPrompt, LLM_MODEL_SUMMARIZATION, MAX_TOKENS_SECTION_SUMMARY, 0.2);
       return { name: sectionName, summary: summaryText || "Summary generation failed or findings were insufficient to summarize.", bullets: currentBullets };
     }));
   
     let execSummaryContext = sectionsOutput
       .filter(s => s.summary && !s.summary.toLowerCase().includes("no specific findings") && !s.summary.toLowerCase().includes("insufficient to summarize"))
       .map(s => `From ${s.name}: ${s.summary}`)
       .join("\n\n");
   
     const topOverallFindingsText = sectionsOutput.flatMap(s => s.bullets)
       .filter(b => b.severity === "CRITICAL" || b.severity === "HIGH")
       .sort((a, b) => {
           const severityRank = { "CRITICAL": 1, "HIGH": 2, "MEDIUM": 3, "LOW": 4, "INFO": 5 };
           if (severityRank[a.severity] !== severityRank[b.severity]) {
               return severityRank[a.severity] - severityRank[b.severity];
           }
           const categoryA: SectionName = a.llmSuggestedCategory || (a.origin === 'heuristic_snippet' || a.origin === 'file_placeholder' ? 'Misc' : 'Misc');
           const categoryB: SectionName = b.llmSuggestedCategory || (b.origin === 'heuristic_snippet' || b.origin === 'file_placeholder' ? 'Misc' : 'Misc');
           
           const sectionIndexA = SECTIONS.indexOf(categoryA);
           const sectionIndexB = SECTIONS.indexOf(categoryB);
   
           if (sectionIndexA !== sectionIndexB) { return sectionIndexA - sectionIndexB; }
           return 0;
       })
       .slice(0, 5).map(b => `- ${b.text} (Severity: ${b.severity}, ${b.citationMarker})`).join("\n");
   
     if (topOverallFindingsText) execSummaryContext += `\n\nNoteworthy Critical/High Findings:\n${topOverallFindingsText}`;
     if (!execSummaryContext.trim()) execSummaryContext = "Overall assessment based on automated web search indicates limited specific actionable findings or risks at this time. Manual review of flagged files is recommended.";
   
     llmSummarizationCalls++;
     const executiveSummaryPrompt = `Synthesize a 3-6 sentence executive summary for a web OSINT due diligence report on "${companyCanon}", based ONLY on the provided context. Highlight the most impactful intelligence. Objectively state the overall picture. If findings are limited, state so.`;
     const execSystemPrompt = "You are a principal OSINT investigator. Provide a concise, factual executive summary for a due diligence report.";
     const executiveSummary = await callLlmApi(executiveSummaryPrompt, execSystemPrompt, LLM_MODEL_SUMMARIZATION, MAX_TOKENS_EXEC_SUMMARY, 0.3);
     console.log(`[OsintSpider] LLM summaries generated. Summarization calls: ${llmSummarizationCalls}`);
   
     const finalLlmCost = calculateLlmCallCost(totalLlmInputTokens, totalLlmOutputTokens);
     const costBreakdown={
       serper: serperQueries * 0.001, firecrawl: firecrawlGlobalSuccesses * 0.002,
       proxycurl: proxycurlCalls * 0.01, llm: +finalLlmCost.toFixed(4), total: 0,
     };
     costBreakdown.total = +(costBreakdown.serper + costBreakdown.firecrawl + costBreakdown.proxycurl + costBreakdown.llm).toFixed(4);
     const wallTimeSeconds = (performance.now() - t0) / 1000;
   
     console.log(`[OsintSpider Finished] Wall time: ${wallTimeSeconds.toFixed(1)}s. LLM Cost: $${costBreakdown.llm}. Total Cost: $${costBreakdown.total}`);
   
     return {
       company: company_name, domain, generated: new Date().toISOString(),
       summary: executiveSummary || "Executive summary could not be generated.",
       sections: sectionsOutput,
       citations: citationsList.slice(0, MAX_SOURCES_TO_LLM * 2 + owner_names.length + 10),
       filesForManualReview: filesForManualReviewList,
       cost: costBreakdown,
       stats: {
           serperQueries, serperResultsProcessed,
           firecrawlTargets: prioritizedScrapingTargets.length,
           firecrawlAttempts: firecrawlGlobalAttempts, firecrawlSuccesses: firecrawlGlobalSuccesses,
           pagesForDeepAnalysis: pagesForDeepAnalysisCount,
           llmInsightExtractionCalls, llmSummarizationCalls, llmFilePredictionCalls,
           totalLlmInputTokens, totalLlmOutputTokens,
           proxycurlCalls, wallTimeSeconds: parseFloat(wallTimeSeconds.toFixed(1))
       }
     };
   }
   
   // Example usage:
   // async function testOsintSpider() {
   //   if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
   //     console.error("Cannot run test: Missing API keys in environment."); return;
   //   }
   //   try {
   //     const results = await runOsintSpider({
   //       company_name: "South Sound Electric Inc",
   //       domain: "southsoundelectric.com",
   //       owner_names: ["Raymond Boink"]
   //     });
   //     console.log("\n\n--- OsintSpider FINAL PAYLOAD ---");
   //     console.log("Executive Summary:", results.summary);
   //     results.sections.forEach(s => {
   //         console.log(`\n--- ${s.name} (${s.bullets.length} bullets) ---`);
   //         console.log(s.summary);
   //         s.bullets.slice(0,3).forEach(b => console.log(`  - LVL:${b.severity} ${b.text.slice(0,100)}... ${b.citationMarker})`));
   //     });
   //     if(results.filesForManualReview.length > 0) {
   //         console.log("\n--- Files for Manual Review ---");
   //         results.filesForManualReview.slice(0,3).forEach(f => console.log(`  - ${f.title} (${f.predictedInterest}) ${f.citationMarker}`));
   //     }
   //     console.log("\nStats:", results.stats);
   //     console.log("Costs:", results.cost);
   //   } catch (error: unknown) {
   //     const err = error instanceof Error ? error : new Error(String(error));
   //     console.error("Test OsintSpider failed:", err.message, err.stack);
   //   }
   // }
   // testOsintSpider();