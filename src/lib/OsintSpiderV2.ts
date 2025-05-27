/*  OSINT-Spider-V2  –  2025-05-27
    -------------------------------------------------------------
    Web-only due-diligence pipeline
      • Serper ≤600  • Firecrawl ≤200  • ProxyCurl ≤10
      • GPT-4.1-mini summaries (no budget guard)
      • 6 sections, ≤50 bullets each
      • Strict TypeScript (no implicit any)
*/

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import fetch from "node-fetch";
import { z } from "zod";
import OpenAI from "openai";

export const runtime = "nodejs";

/*────────────────────────── ENV ──────────────────────────*/
const {
  SERPER_KEY,
  FIRECRAWL_KEY,
  PROXYCURL_KEY,
  OPENAI_API_KEY,
} = process.env;
if (!SERPER_KEY || !FIRECRAWL_KEY || !PROXYCURL_KEY || !OPENAI_API_KEY) {
  throw new Error(
    "Missing SERPER_KEY, FIRECRAWL_KEY, PROXYCURL_KEY or OPENAI_API_KEY",
  );
}

/*──────────────────────── CONSTANTS ──────────────────────*/
const SERPER = "https://google.serper.dev/search";
const FIRE = "https://api.firecrawl.dev/v1/scrape";
const CURL_P = "https://nubela.co/proxycurl/api/v2/linkedin";
const CURL_C = "https://nubela.co/proxycurl/api/linkedin/company";

const MAX_SERPER = 600;
const MAX_SERP_PAGE = 10;
const MAX_FIRE = 200;
const MAX_CURL = 10;
const BATCH_FIRE = 20;
const FIRE_TIMEOUT = 6_000;
const WALL_MS = 12 * 60_000;

const MODEL = "gpt-4.1-mini-2025-04-14";

const SECTIONS = [
  "Corporate",
  "Legal",
  "Cyber",
  "Reputation",
  "Leadership",
  "Misc",
] as const;
type SectionName = (typeof SECTIONS)[number];

const BULLET_CAP = 50;
const BULLET_LEN = 500;
const EXEC_TOK = 300;
const SECT_TOK = 160;

/*──────────────────────── TYPES ──────────────────────────*/
type Sev = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
interface Bullet {
  text: string;
  source: number;
  sev: Sev;
}
interface Section {
  name: SectionName;
  summary: string;
  bullets: Bullet[];
}
interface Citation {
  marker: string;
  url: string;
  title: string;
  snippet: string;
}

interface SerperOrganic {
  title: string;
  link: string;
  snippet?: string;
}
interface SerperResp {
  organic?: SerperOrganic[];
}

interface FirecrawlResp {
  article?: { text_content?: string };
}

interface ProxyCurlProfile {
  headline?: string;
}
interface ProxyCurlCompany {
  industry?: string;
  founded_year?: number;
}

export interface SpiderPayload {
  company: string;
  domain: string;
  generated: string;
  summary: string;
  sections: Section[];
  citations: Citation[];
  cost: {
    serper: number;
    firecrawl: number;
    proxycurl: number;
    llm: number;
    total: number;
  };
}

/*────────────────────── INPUT SCHEMA ───────────────────*/
const schema = z.object({
  company_name: z.string().trim().min(1),
  domain: z.string().trim().min(3),
  owner_names: z.array(z.string().trim()).optional(),
});

/*──────────────────────── HELPERS ───────────────────────*/
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const tokens = (s: string) => Math.ceil(s.length / 3.5);
const price = (inT: number, outT: number) => inT * 0.0004 + outT * 0.0016;



/* LLM wrapper */
const ai = new OpenAI({ apiKey: OPENAI_API_KEY! });
let usdSpent = 0;
async function llm(prompt: string, ctx: string, maxTokens: number): Promise<string> {
  const result = await ai.chat.completions.create({
    model: MODEL,
    temperature: 0.25,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: ctx },
    ],
  });
  usdSpent += price(
    tokens(prompt) + tokens(ctx),
    result.usage?.completion_tokens ?? maxTokens,
  );
  return result.choices[0].message.content!.trim();
}

async function postJSON<T>(
  url: string,
  body: unknown,
  hdr: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...hdr, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

/*──────────────────────── REGEX / SCORE ────────────────*/
const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const RE_PHONE = /\b(\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/g;
const RE_SECRET =
  /\b(api[_-]?key|token|secret|password|authorization|bearer|credential)\b/i;
const RE_PDFXLS = /\.(pdf|xlsx|csv)$/i;
const RISK_WORDS =
  /breach|leak|ransom|hack|apikey|secret|password|token|credential|lawsuit|complaint|sec filing|10-k|10-q|vulnerability|malware/i;

const classify = (s: string): Sev => {
  const t = s.toLowerCase();
  if (RE_SECRET.test(t) || /data (breach|leak)/.test(t)) return "CRITICAL";
  if (RISK_WORDS.test(t)) return "HIGH";
  if (/index of/.test(t) || RE_PDFXLS.test(t)) return "MEDIUM";
  return "LOW";
};

const jaccard = (a: string, b: string) => {
  const A = new Set(a.toLowerCase().split(/\W+/));
  const B = new Set(b.toLowerCase().split(/\W+/));
  const inter = [...A].filter(x => B.has(x)).length;
  return inter / (A.size + B.size - inter);
};

/*──────────────────────── SCORING FUNCTION ─────────────*/
const scoreSerp = (o: SerperOrganic, domain: string): number => {
  let s = 0;
  if (o.link.includes(domain)) s += 0.3;
  if (RE_EMAIL.test(o.snippet ?? "") || RE_PHONE.test(o.snippet ?? "")) s += 0.2;
  if (/\.(gov|edu|mil)/.test(o.link) || RE_PDFXLS.test(o.link)) s += 0.2;
  if (RISK_WORDS.test(o.snippet ?? "")) s += 0.2;
  if (/index of|error/i.test(o.title)) s += 0.1;
  return s;
};

/*──────────────────────── CONTENT CLASSIFIERS ──────────*/
const classifyContent = (
  text: string,
  url: string,
  title: string,
): SectionName => {
  const content = `${text} ${title}`.toLowerCase();

  // Cyber indicators (highest priority for security issues)
  if (
    content.match(
      /breach|hack|vulnerability|security incident|data leak|cyber|malware|phishing|ransomware|exposed|credentials|api[_-]?key|token|password/,
    ) ||
    url.includes("github.com") ||
    url.includes("pastebin") ||
    url.includes("archive.org")
  ) {
    return "Cyber";
  }

  // Legal indicators  
  if (
    content.match(
      /lawsuit|litigation|court case|legal action|violation|complaint|settlement|sec filing|10-k|10-q|regulatory|fine|penalty/,
    ) ||
    url.match(/sec\.gov|justia|law|legal|court|docket/)
  ) {
    return "Legal";
  }

  // Leadership indicators
  if (
    content.match(
      /\b(ceo|president|founder|director|executive|management|board member|owner|principal)\b/,
    ) ||
    url.includes("linkedin.com") ||
    content.match(/biography|profile.*executive/)
  ) {
    return "Leadership";
  }

  // Reputation indicators
  if (
    content.match(
      /review|rating|star|complaint|testimonial|feedback|recommendation|customer.*service|bbb.*rating/,
    ) ||
    url.match(/yelp|google.*review|bbb\.org|trustpilot|facebook|twitter|nextdoor/) ||
    content.match(/\d+\.\d+.*star|rated.*out of/)
  ) {
    return "Reputation";
  }

  // Corporate (financial, business info)
  if (
    content.match(
      /revenue|profit|financial|earnings|business.*model|company.*info|corporation|incorporated|established.*\d{4}|founded/,
    ) ||
    content.match(/annual.*report|quarterly|financial.*statement/)
  ) {
    return "Corporate";
  }

  return "Misc";
};

const isHighQualityContent = (text: string): boolean => {
  // Filter out obvious junk first
  if (text.length < 50) return false;
  if (text.match(/^(call now|click here|visit website|more info|directions)/i))
    return false;
  if (text.match(/cookies?.*policy|privacy policy|terms of service|lorem ipsum/i))
    return false;

  // Filter repetitive marketing templates
  const marketingJunk = [
    /call.*\(\d{3}\).*\d{3}-\d{4}.*for.*estimate/i,
    /trusted.*since.*\d{4}.*serving/i,
    /competitive.*pricing.*free.*estimate/i,
  ];
  if (marketingJunk.some(p => p.test(text))) return false;

  // If it passes the junk filters, it's decent quality
  // High-value patterns aren't required but add confidence
  return true;
};

/*──────────────────────── MAIN ─────────────────────────*/
export async function runSpider(raw: unknown): Promise<SpiderPayload> {
  const t0 = performance.now();
  const { company_name, domain, owner_names = [] } = schema.parse(raw);

  const canon = company_name
    .toLowerCase()
    .replace(
      /[,.]?\s*(inc|llc|ltd|corp(or)?(ation)?|limited|company|co)\s*$/i,
      "",
    )
    .replace(/[.,']/g, "")
    .trim();

  /* containers */
  const bullets: Record<SectionName, Bullet[]> = {
    Corporate: [],
    Legal: [],
    Cyber: [],
    Reputation: [],
    Leadership: [],
    Misc: [],
  };
  const citations: Citation[] = [];
  const hostCount: Record<string, number> = {};

  /* stats */
  let serper = 0,
    fire = 0,
    curl = 0;

  /*──── targeted dorks ────*/
  const buildTargetedQueries = (
    canonName: string,
    dom: string,  
    owners: string[],
  ) => {
    const queries: string[] = [
      // High-value documents
      `"${canonName}" filetype:pdf (annual OR financial OR report OR filing)`,
      `"${canonName}" filetype:xlsx (financial OR data OR report)`,
      `"${canonName}" filetype:csv`,
      
      // Legal and regulatory
      `"${canonName}" site:sec.gov`,
      `"${canonName}" (lawsuit OR litigation OR "legal action" OR violation)`,
      
      // Security and technical
      `"${dom}" (breach OR "data leak" OR security OR vulnerability) -tutorial`,
      `"${dom}" (api OR key OR token OR password) -guide -tutorial -example`,
      `"@${dom}" site:github.com`,
      
      // Business intelligence
      `"${canonName}" (acquisition OR merger OR partnership OR "press release")`,
      `"${canonName}" -site:${dom} (review OR complaint OR rating)`,
      
      // Leadership
      ...owners.slice(0, 3).map(o => `"${o}" "${canonName}" (profile OR biography OR executive)`),
      
      // Fallback broad searches
      `"${canonName}" -marketing -advertisement`,
      `site:${dom} -www.${dom}`,
    ];
    return queries;
  };

  const initialQueries = buildTargetedQueries(canon, domain, owner_names);
  const queue: string[] = [...initialQueries];
  const seenQ = new Set<string>(queue);
  const seenUrl = new Set<string>();

  interface Hit {
    title: string;
    link: string;
    snippet?: string;
    score: number;
  }
  const hits: Hit[] = [];

  /*──────── SERPER BFS ───────*/
  while (queue.length && serper < MAX_SERPER && performance.now() - t0 < WALL_MS) {
    const q = queue.shift()!;
    const sr = await postJSON<SerperResp>(
      SERPER,
      { q, num: MAX_SERP_PAGE, gl: "us", hl: "en" },
      { "X-API-KEY": SERPER_KEY! },
    ).catch(() => ({ organic: [] }));
    serper++;

    for (const o of sr.organic ?? []) {
      const url = o.link;
      if (!url) continue;
      const norm = url.replace(/(\?|#).*/, "");
      if (seenUrl.has(norm)) continue;
      seenUrl.add(norm);

      const joined = `${o.title} ${o.snippet}`.toLowerCase();
      if (!joined.includes(canon) && !joined.includes(domain)) continue;

      hits.push({
        title: o.title,
        link: url,
        snippet: o.snippet,
        score: scoreSerp(o, domain),
      });

      /* host expansion */
      try {
        const host = new URL(url).hostname;
        if (!seenQ.has(host)) {
          seenQ.add(host);
          queue.push(`("${canon}" OR "${domain}") site:${host}`);
        }
      } catch {
        /* ignore */
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);

  /*──────── ProxyCurl enrich ─────*/
  const liCo = hits.find(h => h.link.includes("linkedin.com/company/"));
  if (liCo && curl < MAX_CURL) {
    const r = await fetch(`${CURL_C}?url=${encodeURIComponent(liCo.link)}`, {
      headers: { Authorization: `Bearer ${PROXYCURL_KEY!}` },
    }).catch(() => null);
    curl++;
    if (r?.ok) {
      const j = (await r.json()) as ProxyCurlCompany;
      hits.unshift({
        ...liCo,
        snippet: `${j.industry ?? ""} ${j.founded_year ?? ""}`.trim(),
        score: 0.8,
      });
    }
  }
  for (const owner of owner_names.slice(0, 9)) {
    if (curl >= MAX_CURL) break;
    const sr = await postJSON<SerperResp>(
      SERPER,
      { q: `"${owner}" "linkedin.com/in/"`, num: 5, gl: "us", hl: "en" },
      { "X-API-KEY": SERPER_KEY! },
    ).catch(() => ({ organic: [] }));
    serper++;
    const p = sr.organic?.[0];
    if (!p) continue;
    const enrich = await fetch(
      `${CURL_P}?linkedin_profile_url=${encodeURIComponent(p.link)}`,
      { headers: { Authorization: `Bearer ${PROXYCURL_KEY!}` } },
    ).catch(() => null);
    curl++;
    const headline = enrich?.ok ? ((await enrich.json()) as ProxyCurlProfile).headline : "";
    hits.unshift({
      title: `${owner} – LinkedIn`,
      link: p.link,
      snippet: headline,
      score: 0.7,
    });
  }

  /*──────── Firecrawl ───────*/
  const targets = hits.slice(0, MAX_FIRE);
  const scraped = new Map<string, string>();
  for (let i = 0; i < targets.length && fire < MAX_FIRE; i += BATCH_FIRE) {
    await Promise.all(
      targets.slice(i, i + BATCH_FIRE).map(async h => {
        if (performance.now() - t0 >= WALL_MS) return;
        const txt = await Promise.race([
          postJSON<FirecrawlResp>(
            FIRE,
            { url: h.link, depth: 0 },
            { Authorization: `Bearer ${FIRECRAWL_KEY!}` },
          ),
          new Promise<null>((_, rej) => setTimeout(() => rej("TO"), FIRE_TIMEOUT)),
        ])
          .then(r => r?.article?.text_content ?? null)
          .catch(() => null);
        fire++;
        if (txt) scraped.set(sha256(h.link), txt);
      }),
    );
  }

  /*──────── Enhanced Deduplication ─────*/
  const isDuplicate = (
    newText: string,
    allBul: Record<SectionName, Bullet[]>,
  ): boolean => {
    const newClean = newText.toLowerCase().replace(/\s+/g, " ").trim();
    const allExisting = Object.values(allBul).flat();
    
    return allExisting.some(b => {
      const exist = b.text.toLowerCase().replace(/\s+/g, " ").trim();
      
      // High similarity check (Jaccard > 0.75)
      const sim = jaccard(newClean, exist);
      if (sim > 0.75) return true;

      // Phone number repetition check
      const newPhones = (newClean.match(RE_PHONE) ?? []) as string[];
      const existPhones = (exist.match(RE_PHONE) ?? []) as string[];
      if (
        newPhones.length > 0 &&
        existPhones.length > 0 &&
        newPhones.some(p => (existPhones as string[]).includes(p)) &&
        sim > 0.5
      ) {
        return true;
      }

      // Marketing template repetition
      const marketing = [
        /established.*\d{4}.*serving/,
        /call.*for.*estimate/,
        /competitive.*pricing/,
        /trusted.*electrical/,
      ];
      const bothTemplate = marketing.some(
        t => t.test(newClean) && t.test(exist),
      );
      return bothTemplate && sim > 0.4;
    });
  };

  const addBullet = (sec: SectionName, text: string, src: number) => {
    if (bullets[sec].length >= BULLET_CAP) return;

    // Content quality check
    if (!isHighQualityContent(text)) return;
    
    // Global deduplication check
    if (isDuplicate(text, bullets)) return;
    
    // Domain relevance check
    if (!text.toLowerCase().includes(canon) && !text.toLowerCase().includes(domain)) return;

    // Safe host extraction and diversity check
    const srcUrl = citations[src - 1]?.url ?? "";
    let host = "unknown";
    try {
      if (srcUrl) host = new URL(srcUrl).hostname;
    } catch {
      // ignore invalid URLs
    }
    
    if ((hostCount[host] = (hostCount[host] ?? 0) + 1) > 6) return;

    const sev = classify(text);
    bullets[sec].push({ text, source: src, sev });
  };

  /*──────── Process tar gets ─────────*/
  targets.forEach((h, idx) => {
    const body = scraped.get(sha256(h.link)) ?? h.snippet ?? h.title;
    const txt = trunc(body.replace(/\s+/g, " ").trim(), BULLET_LEN);

    citations[idx] = {
      marker: `[${idx + 1}]`,
      url: h.link,
      title: h.title,
      snippet: trunc(txt, 250),
    };

    // Use content-based classification
    const sec = classifyContent(txt, h.link, h.title);
    addBullet(sec, txt, idx + 1);
  });

  /*──────── Section summaries ─────────*/
  const sections: Section[] = await Promise.all(
    SECTIONS.map(async name => {
      const bl = bullets[name];
      if (!bl.length) return { name, summary: "NSTR", bullets: bl };
      const c = bl.filter(b => b.sev === "CRITICAL").length;
      const h = bl.filter(b => b.sev === "HIGH").length;
      const summary = await llm(
        `${bl.length} findings (${c} CRITICAL, ${h} HIGH). Summarize in ≤3 sentences; no new facts.`,
        bl.map(b => b.text).join("\n"),
        SECT_TOK,
      );
      return { name, summary, bullets: bl };
    }),
  );

  /*──────── Executive summary ─────────*/
  const exec = await llm(
    "Write a 3–5 sentence executive summary using ONLY the bullet list.",
    sections.flatMap(s => s.bullets.map(b => b.text)).join("\n"),
    EXEC_TOK,
  );

  /*──────── Cost ──────────────────────*/
  const cost = {
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