import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { LocationProvider } from "./contexts/LocationContext";
import { EquipmentProvider } from "./contexts/EquipmentContext";
import { autoImportApi, type AutoImportConfig } from "./lib/tauri/commands";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Todo from "./pages/Todo";
import Collections from "./pages/Collections";
import CollectionDetail from "./pages/CollectionDetail";
import Plan from "./pages/Plan";
import Observations from "./pages/Observations";
import Targets from "./pages/Targets";
import ImageViewer from "./pages/ImageViewer";
import Images from "./pages/Images";
import Slideshow from "./pages/Slideshow";
import Admin from "./pages/Admin";

function App() {
  // Auto-start auto-import if it was enabled in settings
  useEffect(() => {
    try {
      const saved = localStorage.getItem("auto_import_config");
      if (saved) {
        const config: AutoImportConfig = JSON.parse(saved);
        const hasSources = (config.sources?.length > 0) || (config.watchFolders?.length ?? 0) > 0;
        if (config.enabled && hasSources) {
          // Merge plate solve settings from localStorage
          const fullConfig: AutoImportConfig = {
            ...config,
            plateSolveSolver: localStorage.getItem("plate_solve_solver") || undefined,
            plateSolveApiKey: localStorage.getItem("astrometry_api_key") || undefined,
            plateSolveApiUrl: localStorage.getItem("local_astrometry_url") || undefined,
          };
          autoImportApi.start(fullConfig).catch(console.error);
        }
      }
    } catch { /* ignore */ }
  }, []);

  return (
    <LocationProvider>
      <EquipmentProvider>
        <div className="dark min-h-screen bg-background text-foreground">
          <Routes>
            <Route path="/slideshow" element={<Slideshow />} />
            <Route element={<Layout />}>
              <Route path="/" element={<Home />} />
              <Route path="/todo" element={<Todo />} />
              <Route path="/collections" element={<Collections />} />
              <Route path="/plan" element={<Plan />} />
              <Route path="/observations" element={<Observations />} />
              <Route path="/images" element={<Images />} />
              <Route path="/targets" element={<Targets />} />
              <Route path="/settings" element={<Admin />} />
              <Route path="/i/:id" element={<ImageViewer />} />
              <Route path="/collections/:id" element={<CollectionDetail />} />
            </Route>
          </Routes>
          <Toaster />
        </div>
      </EquipmentProvider>
    </LocationProvider>
  );
}

export default App;
