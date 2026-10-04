import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MirrorPick · Skincare shopping assistant",
  description: "Compare skincare evidence and manage limited sandbox purchases",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
