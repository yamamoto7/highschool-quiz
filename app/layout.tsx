import type { Metadata, Viewport } from "next";
import { Yusei_Magic, Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

const chalk = Yusei_Magic({ weight: "400", subsets: ["latin"], variable: "--font-chalk", display: "swap" });
const gothic = Zen_Kaku_Gothic_New({ weight: ["400", "500", "700"], subsets: ["latin"], variable: "--font-gothic", display: "swap" });

export const metadata: Metadata = {
  title: "出身高校、当てます。",
  description: "海は見えましたか。坂はきつかったですか。はい・いいえで答えるだけで、全国の高校からあなたの母校を言い当てます。",
};

export const viewport: Viewport = { themeColor: "#e9e2d0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${chalk.variable} ${gothic.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
