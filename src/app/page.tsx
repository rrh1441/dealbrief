/* -------------------------------------------------------------------------- */
/*  src/app/page.tsx                                                          */
/* -------------------------------------------------------------------------- */
"use client";

import { useState, useEffect, useRef, type FormEvent } from "react"; /* ← added useRef */
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
import { Loader2, CheckCircle2 } from "lucide-react";
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
  <h2><strong>Meeting Brief: Jensen Huang – NVIDIA</strong></h2>
  <p>&nbsp;</p>
  <h3><strong>Executive Summary</strong></h3>
  <p>
    Jensen Huang is the founder and CEO of NVIDIA, a position he has held since
    founding the company in 1993.<sup><a href="https://nvidianews.nvidia.com/bios/jensen-huang" target="_blank" rel="noopener noreferrer">6</a></sup>
  </p>
  <p>&nbsp;</p>
  <h3><strong>Job History</strong></h3>
  <ul class="list-disc pl-5">
    <li>Founder and CEO — NVIDIA (1993 – Present)</li>
    <li>Dishwasher, Busboy, Waiter — Denny's (1978 – 1983)</li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Highlights</strong></h3>
  <ul class="list-disc pl-5">
    <li>
      Jensen Huang co-founded NVIDIA in 1993 and has led it to become the most
      valuable public company in the world as of 2024.<sup><a href="https://www.carnegie.org/awards/honoree/jensen-huang/" target="_blank" rel="noopener noreferrer">14</a></sup>
    </li>
    <li>
      Before founding NVIDIA, Jensen Huang worked at Denny's as a dishwasher,
      busboy and waiter from 1978 to 1983.<sup><a href="https://www.dennys.com/jensen-huang-dennys-story-his-favorite-order-how-make-it" target="_blank" rel="noopener noreferrer">16</a></sup>
    </li>
    <li>
      Jensen Huang's journey from working at Denny's to leading a trillion-dollar tech company inspired Denny's to create a special
      'NVIDIA Breakfast Bytes' menu item in his honor.<sup><a href="https://www.dennys.com/news/dennys-debuts-new-nvidiar-breakfast-bytes" target="_blank" rel="noopener noreferrer">17</a></sup>
    </li>
    <li>
      NVIDIA was originally launched from a local Denny's restaurant where Jensen Huang and his co-founders met and planned the company.<sup><a href="https://en.wikipedia.org/wiki/Jensen_Huang" target="_blank" rel="noopener noreferrer">18</a></sup>
    </li>
  </ul>
  <p>&nbsp;</p>
  <h3><strong>Detailed Research Notes</strong></h3>
  <ul class="list-disc pl-5">
    <li>
      Jensen Huang has served as president, CEO and board member of NVIDIA continuously since its founding in 1993.<sup><a href="https://nvidianews.nvidia.com/bios/jensen-huang" target="_blank" rel="noopener noreferrer">6</a></sup>
    </li>
    <li>
      He has publicly emphasized the transformative impact of AI and accelerated computing in recent keynote addresses including GTC 2025.<sup><a href="https://www.nvidia.com/gtc/keynote/" target="_blank" rel="noopener noreferrer">12</a></sup>
    </li>
    <li>
      Jensen Huang has acknowledged the global competition in AI, noting that China is 'not behind' in artificial intelligence development.<sup><a href="https://www.cnbc.com/2025/04/30/nvidia-ceo-jensen-huang-says-china-not-behind-in-ai.html" target="_blank" rel="noopener noreferrer">9</a></sup>
    </li>
    <li>
      His early work experience at Denny's included roles as dishwasher, busboy and waiter which he credits with teaching him valuable life lessons.<sup><a href="https://www.dennys.com/jensen-huang-dennys-story-his-favorite-order-how-make-it" target="_blank" rel="noopener noreferrer">16</a></sup>
    </li>
    <li>
      NVIDIA's founding story is closely tied to Silicon Valley culture with a commemorative plaque unveiled at the Denny's where the company was conceived.<sup><a href="https://blogs.nvidia.com/blog/nvidia-dennys-trillion/" target="_blank" rel="noopener noreferrer">19</a></sup>
    </li>
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
  const formRef = useRef<HTMLFormElement | null>(null); /* ← NEW */

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
        el.defaultValue = el.value;          /* ← NEW */
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
            <Link href="#" className="hover:text-indigo-600">
              Why Non-Financial DD
            </Link>
            <Link href="#" className="hover:text-indigo-600">
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

      {/* HERO + FORM + DEMO ------------------------------------------------- */}
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

          {/* FORM ----------------------------------------------------------- */}
          <motion.form
            ref={formRef} /* ← NEW */
            id="generate"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.4 } }}
            onSubmit={submit}
            className="w-full max-w-xl mx-auto bg-white rounded-2xl shadow-lg p-6 flex flex-col gap-4"
          >
            <div className="flex items-center gap-2">
              <Label htmlFor="companyName" className="w-32">
                Company Name
              </Label>
              <Input
                id="companyName"
                placeholder="Acme Widgets"
                value={form.companyName}
                onChange={(e) =>
                  setForm({ ...form, companyName: e.target.value })
                }
                required
              />
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="companyDomain" className="w-32">
                Domain
              </Label>
              <Input
                id="companyDomain"
                placeholder="acmewidgets.com"
                value={form.companyDomain}
                onChange={(e) =>
                  setForm({ ...form, companyDomain: e.target.value })
                }
                required
              />
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="companyLeader" className="w-32">
                Company Leader (CEO, Founder, Owner)
              </Label>
              <Input
                id="companyLeader"
                placeholder="Jensen Huang"
                value={form.companyLeader}
                onChange={(e) =>
                  setForm({ ...form, companyLeader: e.target.value })
                }
              />
            </div>

            <Button type="submit" disabled={loading}>
              {loading ? (
                <Loader2 className="animate-spin h-4 w-4" />
              ) : (
                "Generate Deal Brief"
              )}
            </Button>
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
                    Brief ready{" "}
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
                  <CardTitle>Real Example Brief</CardTitle>
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

      {/* FEATURES ----------------------------------------------------------- */}
      <section id="features" className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 grid gap-8 grid-cols-1 sm:grid-cols-3">
          {[
            {
              title: "Deep open source coverage",
              desc: "LinkedIn, filings, press, podcasts & more in one pass.",
            },
            {
              title: "Footnoted sources",
              desc: "Every claim backed by a link — no hidden hallucinations.",
            },
            {
              title: "Conversational hooks",
              desc: "2–3 rapport-building facts to break the ice.",
            },
          ].map((f) => (
            <Card key={f.title} className="shadow-sm">
              <CardHeader>
                <CardTitle>{f.title}</CardTitle>
              </CardHeader>
              <CardContent className="text-slate-600">
                <p>{f.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* USE-CASES ---------------------------------------------------------- */}
      <section className="py-24 bg-slate-50">
        <div className="max-w-5xl mx-auto px-4 space-y-12">
          <h2 className="text-3xl font-semibold text-center">
            Built for every high-stakes meeting
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { name: "Investors", icon: "💼", blurb: "Vet founders before they pitch." },
              { name: "Recruiters", icon: "🎯", blurb: "Assess executive candidates in minutes." },
              { name: "Founders",  icon: "🚀", blurb: "Know your counterpart's angle before negotiations." },
              { name: "Sales",     icon: "📈", blurb: "Skip the research rabbit hole and open with insight." },
            ].map((u) => (
              <Card key={u.name} className="text-center shadow-sm">
                <CardHeader>
                  <CardTitle className="flex flex-col items-center gap-2">
                    <span className="text-4xl">{u.icon}</span>
                    {u.name}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-slate-600">{u.blurb}</p>
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
              q: "How long does a brief take to generate?",
              a: "Around 30 seconds!",
            },
            {
              q: "What data sources are used?",
              a: "Real-time web search, corporate filings, reputable news, podcasts, social-media posts, and public databases from the last 24 months.",
            },
            {
              q: "Is my input stored or shared?",
              a: "No. Inputs and generated briefs can be deleted at your direction and never sold or shared with third parties.",
            },
            {
              q: "Do you guarantee zero hallucinations?",
              a: "Each claim is footnoted with a source so you can verify yourself. While LLMs can err, transparent citations keep errors detectable.",
            },
          ].map((f) => (
            <div key={f.q} className="border-b border-slate-200 pb-4">
              <h3 className="font-medium">{f.q}</h3>
              <p className="text-slate-600 mt-2">{f.a}</p>
            </div>
          ))}
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
