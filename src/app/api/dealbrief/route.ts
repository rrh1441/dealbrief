/* ------------------------------------------------------------------
 *  API route:  POST /api/dealbrief
 *  Body JSON can be either of the following shapes:
 *    { "name": "<person>", "organization": "<company>" }
 *    { "companyLeader": "<person>", "companyName": "<company>", "companyDomain"?: "<url>" }
 * -----------------------------------------------------------------*/

import { NextRequest, NextResponse } from "next/server";
import { buildDealBriefGemini } from "@/lib/DealBriefGeminiPipeline";

/*──────────────────────────  superscript helper  */

function normalizeCitations(
  brief: string,
  citations: { marker: string; url: string }[]
): string {
  if (!Array.isArray(citations) || citations.length === 0) return brief;
  if (typeof brief !== "string") return brief;

  const sup: Record<string, string> = {};
  citations.forEach((c, i) => {
    const n = (i + 1).toString();
    sup[n] =
      `<sup><a class="text-blue-600 underline hover:no-underline" href="${c.url}" target="_blank" rel="noopener noreferrer">${n}</a></sup>`;
  });

  brief = brief.replace(
    /(\[\s*\^|\^)\s*([\d\s,]+)(?=\]|\s|,|$)/g,
    (_m: string, _pre: string, nums: string) => {
      const unique = Array.from(
        new Set(
          nums
            .split(/[\s,]+/)
            .filter((num: string) => num && sup[num])
        )
      );
      return unique.map((num: string) => sup[num]).join("");
    }
  );

  return brief
    .replace(/[\[\]\^,]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*──────────────────────────  POST handler  */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = body.companyLeader ?? body.name;
    const organization = body.companyName ?? body.organization;

    if (!name || !organization) {
      return NextResponse.json(
        { error: "name/companyLeader and organization/companyName are required" },
        { status: 400 }
      );
    }

    // call the briefing pipeline (team will be derived from LinkedIn later)
    const payload = await buildDealBriefGemini(name, organization);

    if (payload.brief && payload.citations?.length) {
      payload.brief = normalizeCitations(payload.brief, payload.citations);
    }

    return NextResponse.json(payload);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "pipeline failed" },
      { status: 500 }
    );
  }
}