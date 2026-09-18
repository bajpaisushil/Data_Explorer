import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DataForge — million-row data explorer',
  description:
    'Explore CSV and JSON files with up to a million rows entirely in your browser. Nothing is uploaded; the dataset never leaves your machine.',
  applicationName: 'DataForge',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f2fa' },
    { media: '(prefers-color-scheme: dark)', color: '#14131a' },
  ],
}

/** Stamps the saved theme before first paint so the UI never flashes. */
const THEME_BOOTSTRAP = `(()=>{try{var t=localStorage.getItem('dataforge.theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
