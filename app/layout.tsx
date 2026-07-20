import type { Metadata } from "next";
import DottedSurface from "@/components/ui/dotted-surface";
import "./globals.css";

export const metadata: Metadata = {
  title: "$febu holders — token analytics",
  description:
    "Deep holder analytics: distribution by percentage buckets and hold-time cohorts.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <DottedSurface />
        {children}
      </body>
    </html>
  );
}
