import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Calendar, ListTodo, Map, Settings, Telescope } from "lucide-react";

interface AppInfo {
  name: string;
  version: string;
  description: string;
}

export default function Home() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    invoke<AppInfo>("get_app_info").then(setAppInfo);
  }, []);

  const navItems = [
    {
      title: "Observations",
      description: "Track daily observations and image collections",
      href: "/observations",
      icon: Calendar,
    },
    {
      title: "Todo",
      description: "Manage your astronomical target list",
      href: "/todo",
      icon: ListTodo,
    },
    {
      title: "Plan",
      description: "Plan observations with altitude data and sky maps",
      href: "/plan",
      icon: Map,
    },
    {
      title: "Admin",
      description: "System management and backups",
      href: "/admin",
      icon: Settings,
    },
  ];

  return (
    <div className="container py-10">
      <div className="mb-10 text-center">
        <div className="mb-4 flex justify-center">
          <Telescope className="h-16 w-16 text-primary" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">
          {appInfo?.name || "Astra"}
        </h1>
        <p className="mt-2 text-lg text-muted-foreground">
          {appInfo?.description || "Astronomy Observation Log"}
        </p>
        {appInfo && (
          <p className="mt-1 text-sm text-muted-foreground">
            Version {appInfo.version}
          </p>
        )}
      </div>

      <div className="mx-auto grid max-w-4xl gap-6 md:grid-cols-2">
        {navItems.map((item) => (
          <Link key={item.href} to={item.href}>
            <Card className="transition-colors hover:border-primary/50 hover:bg-accent">
              <CardHeader>
                <div className="mb-2 flex items-center gap-2">
                  <item.icon className="h-5 w-5 text-primary" />
                  <CardTitle>{item.title}</CardTitle>
                </div>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
