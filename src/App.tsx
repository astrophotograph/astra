import { Routes, Route } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { LocationProvider } from "./contexts/LocationContext";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Todo from "./pages/Todo";
import Collections from "./pages/Collections";
import CollectionDetail from "./pages/CollectionDetail";
import Plan from "./pages/Plan";
import Observations from "./pages/Observations";
import ImageViewer from "./pages/ImageViewer";
import Admin from "./pages/Admin";

function App() {
  return (
    <LocationProvider>
      <div className="dark min-h-screen bg-background text-foreground">
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/todo" element={<Todo />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/observations" element={<Observations />} />
            <Route path="/settings" element={<Admin />} />
            <Route path="/i/:id" element={<ImageViewer />} />
            <Route path="/collections/:id" element={<CollectionDetail />} />
          </Route>
        </Routes>
        <Toaster />
      </div>
    </LocationProvider>
  );
}

export default App;
