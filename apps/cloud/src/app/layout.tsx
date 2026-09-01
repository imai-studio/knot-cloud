import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://knot.imai.tech"),
  title: {
    default: "Knot — connect your agents to Anytype",
    template: "%s · Knot",
  },
  description:
    "A secure control and publishing plane for local agents connected to Anytype.",
  openGraph: {
    title: "Knot",
    description:
      "Connect local agents to Anytype, publish objects, and keep authority on your machine.",
    type: "website",
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fcfaf7",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body className={`${inter.variable} font-sans`}>{children}</body>
    </html>
  );
}
