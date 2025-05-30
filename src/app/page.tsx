/* -------------------------------------------------------------------------- */
/*  src/app/page.tsx                                                          */
/* -------------------------------------------------------------------------- */
"use client";

import { useState, useEffect, useRef, type FormEvent } from "react";
import Link from "next/link";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, Quote } from "lucide-react";
import { motion } from "framer-motion";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/*  Supabase client (public keys only)                                        */
/* -------------------------------------------------------------------------- */
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  process.env.SUPABASE_URL ??
  "";
const supabaseAnon =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  "";

if (!supabaseUrl || !supabaseAnon) {
  throw new Error(
    "Define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel.",
  );
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnon);

/* -------------------------------------------------------------------------- */
/*  Static demo brief shown when no API data is loaded                        */
/* -------------------------------------------------------------------------- */
const sampleBriefHtmlContent = `
<div>
  <h2><strong>Deal Brief: Metal Supermarkets – Franchise Resale</strong></h2>
  <p>&nbsp;</p>
  <h3><strong>Executive Summary</strong></h3>
  <p>
    Metal Supermarkets is a franchised metal supply chain with 85+ locations across North America, operating since 1985.<sup><a href="https://www.metalsupermarkets.com/about/" target="_blank" rel="noopener noreferrer">1</a></sup>
  </p>
  <p>&nbsp;</p>
  <h3><strong>Cyber Findings</strong></h3>
  <ul class="list-disc pl-5">
    <li>No major data breaches reported in public databases</li>
    <li>SSL certificate properly configured across main domains</li>
    <li>Email security protocols (SPF, DKIM) properly implemented</li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Legal & Liens</strong></h3>
  <ul class="list-disc pl-5">
    <li>No federal or state liens found against corporate entities</li>
    <li>Trademark registrations current and active</li>
    <li>Franchise disclosure documents filed properly with regulators</li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Reputation Signals</strong></h3>
  <ul class="list-disc pl-5">
    <li>Strong BBB rating (A+) with minimal complaints</li>
    <li>Positive franchise owner sentiment on industry forums</li>
    <li>No major ESG controversies identified</li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Leadership Background</strong></h3>
  <ul class="list-disc pl-5">
    <li>CEO: 15+ years industry experience, no litigation history</li>
    <li>Management team stable with low turnover</li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Red Flags</strong></h3>
  <ul class="list-disc pl-5">
    <li>None identified requiring immediate attention</li>
  </ul>
</div>
`;

/* -------------------------------------------------------------------------- */
/*  Fixed status phrases for local countdown                                  */
/* -------------------------------------------------------------------------- */
const STEPS = [
  "Sourcing search results …",
  "Verifying profile …",
  "Expanding coverage …",
  "Pulling page details …",
  "Generating summary …",
  "Wrapping up …",
] as const;

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */
export default function Page() {
  /* ─────────────── state */
  const [form, setForm] = useState({
    companyName: "",
    companyDomain: "",
    companyLeader: "",
  });
  const [loading, setLoading] = useState(false);
  const [briefHtml, setBriefHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* timer state */
  const [stepIdx, setStepIdx] = useState(0);
  const [remaining, setRemaining] = useState(45); // seconds

  /* form ref for Safari "unsaved text" workaround */
  const formRef = useRef<HTMLFormElement | null>(null);

  /* advance every second while loading */
  useEffect(() => {
    if (!loading) {
      setStepIdx(0);
      setRemaining(45);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - t0) / 1000);

      /* update time remaining */
      const r = 45 - elapsed;
      setRemaining(r > 5 ? r : 5);           // clamp at 5 s

      /* advance step every 9 s until 45 s total */
      if (elapsed < 45 && elapsed % 9 === 0) {
        setStepIdx((i) =>
          i < STEPS.length - 1 ? i + 1 : i,
        );
      }

      /* stop ticker after 45 s */
      if (elapsed >= 45) clearInterval(id);
    }, 1_000);
    return () => clearInterval(id);
  }, [loading]);

  /* ---------------------------------------------------------------------- */
  /*  Analytics: insert one row per search                                   */
  /* ---------------------------------------------------------------------- */
  const logSearchEvent = async (
    companyName: string,
    companyDomain: string,
    companyLeader: string,
  ) => {
    try {
      await supabase
        .from("search_events")
        .insert([{ companyName, companyDomain, companyLeader }]);
    } catch (err) {
      console.error("Supabase log error:", err);
    }
  };

  /* ─────────────── submit */
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    /* Safari prompt fix: mark current field values as defaults */
    formRef.current
      ?.querySelectorAll<HTMLInputElement>("input")
      .forEach((el) => {
        el.defaultValue = el.value;
      });

    setLoading(true);
    setError(null);
    setBriefHtml(null);

    // Fire-and-forget analytics
    void logSearchEvent(
      form.companyName.trim(),
      form.companyDomain.trim(),
      form.companyLeader.trim(),
    );

    try {
      const res = await fetch("/api/dealbrief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        let payload: unknown;
        try {
          payload = await res.json();
        } catch {
          payload = await res.text();
        }
        throw new Error(
          typeof payload === "string"
            ? payload
            : (payload as { message?: string })?.message ??
                `Request failed (${res.status})`,
        );
      }

      const { brief } = (await res.json()) as { brief: string };
      setBriefHtml(brief);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /* ─────────────── view */
  return (
    <div className="min-h-screen flex flex-col">
      {/* NAVBAR ------------------------------------------------------------- */}
      <nav className="sticky top-0 z-50 backdrop-blur bg-white/80 border-b border-slate-200">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <Link href="/" className="font-semibold text-xl">
            DealBrief
          </Link>

          <div className="hidden md:flex gap-6 items-center">
            <Link href="#features" className="hover:text-indigo-600">
              Features
            </Link>
            <Link href="#why-non-financial" className="hover:text-indigo-600">
              Why Non-Financial DD
            </Link>
            <Link href="#use-cases" className="hover:text-indigo-600">
              Use-Cases
            </Link>
            <Link href="#faq" className="hover:text-indigo-600">
              FAQ
            </Link>
            <Button size="sm" asChild>
              <Link href="#generate">Generate Deal Brief</Link>
            </Button>
          </div>
        </div>
      </nav>

      {/* HERO + FORM -------------------------------------------------------- */}
      <header className="bg-gradient-to-b from-white to-slate-50">
        <div className="max-w-5xl mx-auto px-4 py-24 flex flex-col gap-10 text-center">
          {/* Hero text */}
          <div>
            <h1 className="text-5xl font-bold tracking-tight">
              Think Outside the Books.
            </h1>
            <p className="mt-4 text-lg text-slate-600">
              DealBrief completes cyber, legal, reputation, and leadership diligence in under 3 hours — so you close with facts, not guesswork.
            </p>
          </div>

          {/* RESPONSIVE FORM ------------------------------------------------ */}
          <motion.form
            ref={formRef}
            id="generate"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4 } }}
            onSubmit={submit}
            className="w-full max-w-4xl mx-auto bg-white rounded-2xl shadow-lg p-6"
          >
            {/* Desktop ≥1024px: Row 1 - Company Name (1/2) Domain (1/2), Row 2 - Leadership (3/4) CTA (1/4) */}
            <div className="hidden lg:grid lg:grid-cols-2 lg:gap-4 lg:mb-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyName" className="text-sm font-medium">
                  Company Name
                </Label>
                <Input
                  id="companyName"
                  placeholder="Acme Widgets"
                  value={form.companyName}
                  onChange={(e) =>
                    setForm({ ...form, companyName: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyDomain" className="text-sm font-medium">
                  Domain
                </Label>
                <Input
                  id="companyDomain"
                  placeholder="acmewidgets.com"
                  value={form.companyDomain}
                  onChange={(e) =>
                    setForm({ ...form, companyDomain: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
            </div>
            <div className="hidden lg:grid lg:grid-cols-4 lg:gap-4">
              <div className="lg:col-span-3 flex flex-col gap-2">
                <Label htmlFor="companyLeader" className="text-sm font-medium">
                  Leadership (CEO / Owner)
                </Label>
                <Input
                  id="companyLeader"
                  placeholder="Jane Smith"
                  value={form.companyLeader}
                  onChange={(e) =>
                    setForm({ ...form, companyLeader: e.target.value })
                  }
                  className="rounded-full"
                />
              </div>
              <div className="flex flex-col justify-end">
                <Button type="submit" disabled={loading} className="rounded-full">
                  {loading ? (
                    <Loader2 className="animate-spin h-4 w-4" />
                  ) : (
                    "Generate Deal Brief"
                  )}
                </Button>
              </div>
            </div>

            {/* Tablet 640-1023px: Row 1 - Company Name (1/2) Domain (1/2), Row 2 - Leadership (full) CTA (full) */}
            <div className="hidden sm:grid lg:hidden sm:grid-cols-2 sm:gap-4 sm:mb-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyNameTablet" className="text-sm font-medium">
                  Company Name
                </Label>
                <Input
                  id="companyNameTablet"
                  placeholder="Acme Widgets"
                  value={form.companyName}
                  onChange={(e) =>
                    setForm({ ...form, companyName: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyDomainTablet" className="text-sm font-medium">
                  Domain
                </Label>
                <Input
                  id="companyDomainTablet"
                  placeholder="acmewidgets.com"
                  value={form.companyDomain}
                  onChange={(e) =>
                    setForm({ ...form, companyDomain: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
            </div>
            <div className="hidden sm:flex lg:hidden flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyLeaderTablet" className="text-sm font-medium">
                  Leadership (CEO / Owner)
                </Label>
                <Input
                  id="companyLeaderTablet"
                  placeholder="Jane Smith"
                  value={form.companyLeader}
                  onChange={(e) =>
                    setForm({ ...form, companyLeader: e.target.value })
                  }
                  className="rounded-full"
                />
              </div>
              <Button type="submit" disabled={loading} className="rounded-full">
                {loading ? (
                  <Loader2 className="animate-spin h-4 w-4" />
                ) : (
                  "Generate Deal Brief"
                )}
              </Button>
            </div>

            {/* Mobile <640px: Stack all vertically */}
            <div className="sm:hidden flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyNameMobile" className="text-sm font-medium">
                  Company Name
                </Label>
                <Input
                  id="companyNameMobile"
                  placeholder="Acme Widgets"
                  value={form.companyName}
                  onChange={(e) =>
                    setForm({ ...form, companyName: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyDomainMobile" className="text-sm font-medium">
                  Domain
                </Label>
                <Input
                  id="companyDomainMobile"
                  placeholder="acmewidgets.com"
                  value={form.companyDomain}
                  onChange={(e) =>
                    setForm({ ...form, companyDomain: e.target.value })
                  }
                  className="rounded-full"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="companyLeaderMobile" className="text-sm font-medium">
                  Leadership (CEO / Owner)
                </Label>
                <Input
                  id="companyLeaderMobile"
                  placeholder="Jane Smith"
                  value={form.companyLeader}
                  onChange={(e) =>
                    setForm({ ...form, companyLeader: e.target.value })
                  }
                  className="rounded-full"
                />
              </div>
              <Button type="submit" disabled={loading} className="rounded-full">
                {loading ? (
                  <Loader2 className="animate-spin h-4 w-4" />
                ) : (
                  "Generate Deal Brief"
                )}
              </Button>
            </div>
          </motion.form>

          {/* DEMO / LOADER / OUTPUT ---------------------------------------- */}
          <div className="w-full max-w-5xl mx-auto">
            {loading && (
              <Card>
                <CardHeader>
                  <CardTitle>{STEPS[stepIdx]}</CardTitle>
                  <CardDescription>
                    {remaining > 5 ? `${remaining}s remaining` : "≈ 5 s remaining"}
                  </CardDescription>
                </CardHeader>
                <CardContent />
              </Card>
            )}

            {error && <p className="text-red-600 mt-4">{error}</p>}

            {!loading && briefHtml && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    Deal Brief Complete{" "}
                    <CheckCircle2 className="inline h-5 w-5 text-green-600" />
                  </CardTitle>
                  <CardDescription>Scroll or copy as needed</CardDescription>
                </CardHeader>
                <CardContent className="prose prose-lg prose-slate max-w-none text-left prose-li:marker:text-slate-600">
                  <div
                    dangerouslySetInnerHTML={{ __html: briefHtml }}
                  />
                </CardContent>
              </Card>
            )}

            {!loading && !briefHtml && (
              <Card>
                <CardHeader>
                  <CardTitle>Sample Deal Brief</CardTitle>
                  <CardDescription>Target: Metal Supermarkets – Franchise Resale</CardDescription>
                </CardHeader>
                <CardContent className="prose prose-lg prose-slate max-w-none text-left max-h-96 overflow-auto prose-li:marker:text-slate-600">
                  <div
                    dangerouslySetInnerHTML={{
                      __html: sampleBriefHtmlContent,
                    }}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </header>

      {/* SPEED STRIPE ------------------------------------------------------- */}
      <section className="py-4 text-lg font-semibold text-center text-white bg-slate-800">
        <div className="max-w-6xl mx-auto px-4">
          Traditional diligence drags 4–12 weeks. DealBrief delivers a documented risk brief in under 3 hours.
        </div>
      </section>

      {/* WHY NON-FINANCIAL DD ----------------------------------------------- */}
      <section id="why-non-financial" className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-bold text-center">
            Why Non-Financial Due Diligence?
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {[
              {
                title: "Cyber & Data Exposure",
                desc: "Identify breaches, open ports, leaked secrets, misconfigured storage, and software supply-chain risk before they become your liability."
              },
              {
                title: "Legal & Compliance",
                desc: "Surface lawsuits, liens, regulatory actions, sanctions, and license gaps that can stall integration or trigger indemnities."
              },
              {
                title: "Reputation & Leadership",
                desc: "Analyze press, social sentiment, executive history, ESG controversies, and Glassdoor chatter to gauge cultural and reputational fit."
              }
            ].map((item) => (
              <Card key={item.title} className="shadow-sm">
                <CardHeader>
                  <CardTitle>{item.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">{item.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES ----------------------------------------------------------- */}
      <section id="features" className="py-24 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-semibold text-center">
            Built for professionals who can&apos;t wait
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {[
              {
                title: "Acquirers",
                desc: "Validate targets in < 4 hours. Enter the LOI phase armed with hard facts.",
                border: "border-t-4 border-t-cyan-500"
              },
              {
                title: "Brokers", 
                desc: "Package diligence for buyers and lenders same-day; shorten deal cycles.",
                border: "border-t-4 border-t-cyan-500"
              },
              {
                title: "Lenders & Investors",
                desc: "Reveal hidden risk pre-term-sheet; protect portfolio IRR.",
                border: "border-t-4 border-t-cyan-500"
              }
            ].map((f) => (
              <Card key={f.title} className={`shadow-sm ${f.border}`}>
                <CardHeader>
                  <CardTitle>{f.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-slate-600">
                  <p>{f.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS ------------------------------------------------------- */}
      <section className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-semibold text-center">How It Works</h2>
          <div className="flex flex-col lg:flex-row lg:gap-10 text-center space-y-8 lg:space-y-0">
            {[
              {
                step: "1",
                title: "Submit basic details",
                desc: "Company name, domain, leadership."
              },
              {
                step: "2", 
                title: "Automated multi-source crawl",
                desc: "Live web search, court dockets, breach databases, corporate registries, media."
              },
              {
                step: "3",
                title: "Receive Deal Brief PDF",
                desc: "Actionable report + source links < 3 hrs."
              }
            ].map((item) => (
              <div key={item.step} className="lg:flex-1">
                <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-600 text-white rounded-full text-xl font-bold mb-4">
                  {item.step}
                </div>
                <h3 className="text-xl font-semibold mb-2">{item.title}</h3>
                <p className="text-slate-600">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* USE-CASE GALLERY --------------------------------------------------- */}
      <section id="use-cases" className="py-24 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-semibold text-center">
            Use-Case Gallery
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {[
              {
                name: "Roll-up acquisitions",
                desc: "Rapid target screening for serial acquirers building market dominance through multiple acquisitions.",
                icon: "🎯"
              },
              {
                name: "Franchise diligence", 
                desc: "Comprehensive franchise system analysis including franchisor stability and territory risk assessment.",
                icon: "🏪"
              },
              {
                name: "SBA 7(a) lender checks",
                desc: "Enhanced borrower screening for SBA lenders requiring thorough non-financial risk evaluation.",
                icon: "🏦"
              },
              {
                name: "VC / growth equity add-ons",
                desc: "Portfolio company add-on acquisition screening to identify synergies and integration risks.",
                icon: "🚀"
              }
            ].map((useCase) => (
              <Card key={useCase.name} className="bg-slate-800 text-white shadow-lg">
                <CardHeader>
                  <CardTitle className="flex items-center gap-3">
                    <span className="text-2xl">{useCase.icon}</span>
                    {useCase.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-slate-300">{useCase.desc}</p>
                  <Button variant="outline" size="sm" className="bg-white text-slate-800 hover:bg-slate-100">
                    Generate Deal Brief
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* TESTIMONIALS ------------------------------------------------------- */}
      <section className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-semibold text-center">
            What Our Clients Say
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {[
              {
                quote: "DealBrief cut our pre-LOI diligence from 3 weeks to 4 hours. We can now move faster on competitive deals.",
                author: "Sarah Chen",
                title: "VP Acquisitions, Regional Growth Partners"
              },
              {
                quote: "As a broker, I can now package comprehensive risk analysis for buyers same-day. It's a game-changer for deal velocity.",
                author: "Mike Rodriguez", 
                title: "Principal, Mountain West Business Brokers"
              },
              {
                quote: "The cyber and legal findings helped us avoid a costly acquisition with hidden compliance issues. ROI was immediate.",
                author: "David Park",
                title: "Senior Credit Officer, Community Bank SBA Division"
              }
            ].map((testimonial) => (
              <Card key={testimonial.author} className="shadow-sm">
                <CardHeader>
                  <Quote className="h-8 w-8 text-cyan-500 mb-4" />
                  <CardDescription className="text-base italic">
                    &ldquo;{testimonial.quote}&rdquo;
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="border-t pt-4">
                    <p className="font-semibold">{testimonial.author}</p>
                    <p className="text-sm text-slate-600">{testimonial.title}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ ---------------------------------------------------------------- */}
      <section id="faq" className="py-24 bg-slate-50">
        <div className="max-w-4xl mx-auto px-4 space-y-8">
          <h2 className="text-3xl font-semibold text-center">FAQ</h2>
          {[
            {
              q: "How long does a Deal Brief take?",
              a: "Typically 2–3 hours; max 6 hours for edge cases.",
            },
            {
              q: "What sources are used?",
              a: "Live web, corporate registries, court systems, breach repos, regulatory portals, news, podcasts, social media.",
            },
            {
              q: "Does it replace financial diligence?",
              a: "No. It complements your financial review by exposing non-financial risk.",
            },
            {
              q: "Is my data private?",
              a: "No. Inputs and generated briefs can be deleted at your direction and never sold or shared with third parties.",
            },
          ].map((f) => (
            <div key={f.q} className="border-b border-slate-200 pb-4">
              <h3 className="font-medium">{f.q}</h3>
              <p className="text-slate-600 mt-2">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FINAL CTA BAND ----------------------------------------------------- */}
      <section className="py-16 bg-gradient-to-r from-cyan-500 to-blue-600">
        <div className="max-w-4xl mx-auto px-4 text-center space-y-6">
          <h2 className="text-3xl font-bold text-white">
            Ready to see every hidden risk?
          </h2>
          <Button size="lg" className="bg-white text-slate-800 hover:bg-slate-100 text-lg px-8 py-3">
            Generate Deal Brief
          </Button>
        </div>
      </section>

      {/* FOOTER ------------------------------------------------------------- */}
      <footer className="bg-white border-t border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-10 flex flex-col sm:flex-row justify-between text-sm text-slate-500">
          <p>© {new Date().getFullYear()} DealBrief</p>
        </div>
      </footer>
    </div>
  );
}
