import type { Metadata, Viewport } from "next";
import { fontVariables } from "@/theme/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Nailed Cafe & Lodge", template: "%s | Nailed Cafe & Lodge" },
  description: "Nailed Cafe & Lodge, Uphar Marg, Baluwatar, Kathmandu. Menu and shop.",
};

// Light only: the placeholder direction (concept C) defines no dark theme.
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body className="bg-surface text-ink min-h-dvh font-sans">{children}</body>
    </html>
  );
}
