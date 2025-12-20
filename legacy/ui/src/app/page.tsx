import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen p-8 bg-gradient-to-br from-slate-900 via-purple-900 to-slate-800">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-center mb-12 text-slate-100">
          Welcome to Your Observatory
        </h1>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Observations Panel */}
          <Link href="/observations" className="group">
            <div className="bg-slate-800 rounded-lg shadow-2xl overflow-hidden hover:shadow-purple-500/20 hover:bg-slate-750 transition-all duration-300 border border-slate-600/70 hover:border-indigo-400/50">
              <div className="relative h-48 bg-gradient-to-br from-indigo-500 to-purple-600 shadow-inner">
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </div>
              </div>
              <div className="p-6">
                <h2 className="text-xl font-semibold mb-3 text-slate-100 group-hover:text-indigo-300 transition-colors">
                  Observations
                </h2>
                <p className="text-slate-300 leading-relaxed">
                  Track and document your daily observations, insights, and discoveries.
                  Keep a record of important moments and patterns you notice.
                </p>
              </div>
            </div>
          </Link>

          {/* Todo Panel */}
          <Link href="/todo" className="group">
            <div className="bg-slate-800 rounded-lg shadow-2xl overflow-hidden hover:shadow-emerald-500/20 hover:bg-slate-750 transition-all duration-300 border border-slate-600/70 hover:border-emerald-400/50">
              <div className="relative h-48 bg-gradient-to-br from-emerald-500 to-teal-600 shadow-inner">
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                </div>
              </div>
              <div className="p-6">
                <h2 className="text-xl font-semibold mb-3 text-slate-100 group-hover:text-emerald-300 transition-colors">
                  Todo
                </h2>
                <p className="text-slate-300 leading-relaxed">
                  Manage your astronomical observing targets. Track celestial object
                  visibility and mark observations complete when finished.
                </p>
              </div>
            </div>
          </Link>

          {/* Plan Panel */}
          <Link href="/plan" className="group">
            <div className="bg-slate-800 rounded-lg shadow-2xl overflow-hidden hover:shadow-violet-500/20 hover:bg-slate-750 transition-all duration-300 border border-slate-600/70 hover:border-violet-400/50">
              <div className="relative h-48 bg-gradient-to-br from-violet-500 to-purple-600 shadow-inner">
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
              </div>
              <div className="p-6">
                <h2 className="text-xl font-semibold mb-3 text-slate-100 group-hover:text-violet-300 transition-colors">
                  Plan
                </h2>
                <p className="text-slate-300 leading-relaxed">
                  Plan your observing sessions with optimal timing data. Calculate object
                  altitudes, set goal times, and schedule your astronomical adventures.
                </p>
              </div>
            </div>
          </Link>

          {/* Admin Panel */}
          <Link href="/admin" className="group">
            <div className="bg-slate-800 rounded-lg shadow-2xl overflow-hidden hover:shadow-orange-500/20 hover:bg-slate-750 transition-all duration-300 border border-slate-600/70 hover:border-orange-400/50">
              <div className="relative h-48 bg-gradient-to-br from-orange-500 to-red-600 shadow-inner">
                <div className="absolute inset-0 flex items-center justify-center">
                  <svg className="w-16 h-16 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </div>
              <div className="p-6">
                <h2 className="text-xl font-semibold mb-3 text-slate-100 group-hover:text-orange-300 transition-colors">
                  Admin
                </h2>
                <p className="text-slate-300 leading-relaxed">
                  Manage system backups, restore database, and configure 
                  administrative settings for your observatory.
                </p>
              </div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
