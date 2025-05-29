/* -------------------------------------------------------------------------- */
/*  src/app/layout.tsx                                                        */
/* -------------------------------------------------------------------------- */
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DealBrief",
  description: "DealBrief completes cyber, legal, reputation, and leadership diligence in under 3 hours — so you close with facts, not guesswork.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        {/* Vercel Analytics (loads after main content) */}
        <Analytics />
      </body>
    </html>
  );
}
