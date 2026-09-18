'use client'
import dynamic from 'next/dynamic'

// The explorer creates a worker and touches IndexedDB, so it only ever renders
// in the browser. Keeping it out of the prerender also keeps the static export
// honest: the shipped HTML is a shell, and every byte of data stays local.
const Explorer = dynamic(() => import('@/components/Explorer').then((m) => m.Explorer), {
  ssr: false,
  loading: () => (
    <div className="grid min-h-dvh place-items-center">
      <div className="df-skeleton h-10 w-40 rounded-full" />
    </div>
  ),
})

export default function Page() {
  return <Explorer />
}
