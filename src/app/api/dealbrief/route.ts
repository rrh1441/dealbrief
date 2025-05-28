/* ------------------------------------------------------------------
 *  POST /api/dealbrief
 *
 *  Accepts either body shape:
 *    { "name": "<leader>", "organization": "<company>" }
 *    { "companyLeader": "<leader>", "companyName": "<company>", "companyDomain"?: "<url>" }
 * -----------------------------------------------------------------*/

import { NextRequest, NextResponse } from "next/server";
import { runOsintSpider, OsintSpiderPayload } from "@/lib/OsintSpider";
import { renderSpiderHtmlV4 } from "@/lib/renderSpiderHtml";

export async function POST(req: NextRequest) {
  console.log("[API] Dealbrief request started");
  try {
    /* ── parse body ─────────────────────────────────────────────────── */
    const body         = await req.json();
    console.log("[API] Body parsed:", body);
    
    const leaderName   = body.companyLeader ?? body.name ?? undefined;
    const companyName  = body.companyName   ?? body.organization;
    const companyDomain= body.companyDomain ?? body.company_domain ??
                         (companyName ? companyName.replace(/\s+/g, "").toLowerCase() + ".com" : undefined);

    if (!companyName || !companyDomain) {
      console.log("[API] Missing required fields");
      return NextResponse.json(
        { error: "companyName/organization and companyDomain are required" },
        { status: 400 },
      );
    }

    console.log("[API] Starting OsintSpider...");
    /* ── run OSINT-Spider-V4 ────────────────────────────────────────── */
    const spiderPayload: OsintSpiderPayload = await runOsintSpider({
      company_name: companyName,
      domain:       companyDomain,
      owner_names:  leaderName ? [leaderName] : [],
    });

    console.log("[API] OsintSpider completed, generating HTML...");
    /* ── generate foot-noted HTML ───────────────────────────────────── */
    const briefHtml = renderSpiderHtmlV4(spiderPayload);

    console.log("[API] Success, returning response");
    /* ── respond ────────────────────────────────────────────────────── */
    return NextResponse.json({
      brief: briefHtml,
      citations: spiderPayload.citations,
      cost: spiderPayload.cost,
      filesForManualReview: spiderPayload.filesForManualReview,
      stats: spiderPayload.stats
    });
  } catch (err) {
    console.error("OsintSpider route failed:", err);
    console.error("Error stack:", (err as Error).stack);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
