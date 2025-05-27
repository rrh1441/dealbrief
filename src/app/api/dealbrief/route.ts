/* ------------------------------------------------------------------
 *  POST /api/dealbrief
 *
 *  Accepts either body shape:
 *    { "name": "<leader>", "organization": "<company>" }
 *    { "companyLeader": "<leader>", "companyName": "<company>", "companyDomain"?: "<url>" }
 * -----------------------------------------------------------------*/

import { NextRequest, NextResponse } from "next/server";
import { runOsintSpider } from "@/lib/OsintSpiderV2";
import { renderSpiderHtml } from "@/lib/renderSpiderHtml";

export async function POST(req: NextRequest) {
  try {
    /* ── parse body ─────────────────────────────────────────────────── */
    const body         = await req.json();
    const leaderName   = body.companyLeader ?? body.name ?? undefined;
    const companyName  = body.companyName   ?? body.organization;
    const companyDomain= body.companyDomain ?? body.company_domain ??
                         (companyName ? companyName.replace(/\s+/g, "").toLowerCase() + ".com" : undefined);

    if (!companyName || !companyDomain) {
      return NextResponse.json(
        { error: "companyName/organization and companyDomain are required" },
        { status: 400 },
      );
    }

    /* ── run OSINT-Spider-V2 ────────────────────────────────────────── */
    const spider = await runOsintSpider({
      company_name: companyName,
      domain:       companyDomain,
      owner_names:  leaderName ? [leaderName] : [],
    });

    /* ── generate foot-noted HTML ───────────────────────────────────── */
    const briefHtml = renderSpiderHtml(spider);

    /* ── respond ────────────────────────────────────────────────────── */
    return NextResponse.json({
      brief: briefHtml,
      citations: spider.citations,
      cost: spider.cost,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "pipeline failed" }, { status: 500 });
  }
}
