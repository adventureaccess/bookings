import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import "./globals.css";

// next/font downloads these at build time and serves them from our own
// origin, so the CSP never needs to allow Google Fonts.
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Bookings | Adventure Access",
    template: "%s | Adventure Access",
  },
  description: "Book a place on an Adventure Access trip.",
  // Nothing here should be indexed until the pilot departure goes live.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#1A1612",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-US"
      className={`${cormorant.variable} ${jost.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
