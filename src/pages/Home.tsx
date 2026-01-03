import { Link } from "react-router-dom";
import { Target, ClipboardCheck, BarChart3, Settings } from "lucide-react";

export default function Home() {
  const navItems = [
    {
      title: "Observations",
      description:
        "Track and document your daily observations, insights, and discoveries. Keep a record of important moments and patterns you notice.",
      href: "/observations",
      icon: Target,
      gradient: "from-violet-500 to-purple-600",
    },
    {
      title: "Todo",
      description:
        "Manage your astronomical observing targets. Track celestial object visibility and mark observations complete when finished.",
      href: "/todo",
      icon: ClipboardCheck,
      gradient: "from-emerald-400 to-teal-500",
    },
    {
      title: "Plan",
      description:
        "Plan your observing sessions with optimal timing data. Calculate object altitudes, set goal times, and schedule your astronomical adventures.",
      href: "/plan",
      icon: BarChart3,
      gradient: "from-teal-500 to-green-600",
    },
    {
      title: "Settings",
      description:
        "Configure observer locations, manage backups, and customize your observatory settings.",
      href: "/settings",
      icon: Settings,
      gradient: "from-orange-500 to-red-500",
    },
  ];

  return (
    <div className="min-h-full bg-gradient-to-br from-purple-900 via-violet-900 to-slate-900 py-16 px-4">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-white">
          Welcome to Your Observatory
        </h1>
      </div>

      <div className="mx-auto grid max-w-6xl gap-6 px-4 sm:grid-cols-2 lg:grid-cols-4">
        {navItems.map((item) => (
          <Link key={item.href} to={item.href} className="group">
            <div className="overflow-hidden rounded-xl transition-transform hover:scale-105">
              {/* Gradient icon section */}
              <div
                className={`flex h-40 items-center justify-center bg-gradient-to-br ${item.gradient}`}
              >
                <item.icon className="h-16 w-16 text-white" strokeWidth={1.5} />
              </div>
              {/* Dark content section */}
              <div className="bg-slate-800/90 p-5">
                <h2 className="mb-2 text-lg font-semibold text-white">
                  {item.title}
                </h2>
                <p className="text-sm leading-relaxed text-gray-400">
                  {item.description}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
