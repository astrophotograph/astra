import type {Metadata} from "next"
import {Geist, Geist_Mono, Inter} from "next/font/google"
import "./globals.css"
import {Header} from "@/components/header"
import {ThemeProvider} from "@/components/theme-provider"
import {ClerkProvider} from '@clerk/nextjs'
import {Toaster} from "@/components/ui/sonner"
import {ensureDatabaseInitialized} from '@/lib/database/init'
import {isSQLiteModeServer} from '@/lib/auth/server'

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Initialize database on app startup
if (typeof window === 'undefined') {
  // Server-side only
  ensureDatabaseInitialized().catch(console.error);
}

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Astronomy Observation Log",
  description: "Astronomy Observation Log.",
};

// Always provide ClerkProvider but configure it appropriately for the mode
function AuthWrapper({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthWrapper>
      <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src={"/ph/js/planet_phases.js"}/>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} antialiased  flex flex-col min-h-screen`}
      >
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        // enableSystem
        disableTransitionOnChange
      >
        <Header/>

        {children}

        <footer className="mt-auto">
          <div className="container mx-auto py-4 text-center">
            <p>&copy; 2024-2025 Astro Log Book. All rights reserved. Photos &copy; copyright their author.</p>
          </div>
        </footer>
        <Toaster/>

      </ThemeProvider>
      </body>
      </html>
    </AuthWrapper>
  );
}
