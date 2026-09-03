import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "A self-hosted personal CRM. LinkedIn, Gmail, Calendar and Messages folded into one daily feed of who to talk to next.";

/**
 * Absolute base for og:image and friends — link previews (LinkedIn, Slack,
 * iMessage) refuse relative image URLs. Vercel sets the production URL
 * system variable on every deployment; locally it falls back to dev.
 */
const SITE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Rontext",
  description: DESCRIPTION,
  openGraph: {
    title: "Rontext",
    description: DESCRIPTION,
    siteName: "Rontext",
    type: "website",
    // Static 1200x630 in public/ rather than a generated route: the proxy
    // already lets .png through unauthenticated, and crawlers get it in one
    // cheap request instead of rendering an image function.
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Rontext network graph" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rontext",
    description: DESCRIPTION,
    images: ["/og.png"],
  },
  appleWebApp: {
    capable: true,
    title: "Rontext",
    // Lets the web view run under the status bar so viewportFit "cover" below
    // has something to do; every surface that reaches the top edge already pads
    // itself with env(safe-area-inset-top).
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // Tints the status-bar band in standalone mode. Follows the OS scheme, not
  // the in-app theme picker (meta tags cannot read a class on <html>), so a
  // manual light-in-dark override still gets the dark band.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    // Matches bg-muted dark (oklch 0.269), which is what sits behind the bar.
    { media: "(prefers-color-scheme: dark)", color: "#262626" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // The theme script in (app)/layout adds `dark` here before hydration, so
      // the class list is expected to differ from the server render.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
