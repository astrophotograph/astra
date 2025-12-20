/**
 * Aladin Lite Sky Map Component
 *
 * Interactive sky map using the Aladin Lite library from CDS.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

declare global {
  interface Window {
    A: {
      init: Promise<void>;
      aladin: (element: HTMLElement, options: Record<string, unknown>) => AladinInstance;
    };
  }
}

interface AladinInstance {
  setImageSurvey: (survey: string) => void;
  setFoV: (fov: number) => void;
  gotoObject: (target: string) => void;
  gotoRaDec: (ra: number, dec: number) => void;
  getRaDec: () => [number, number];
}

interface AladinLiteProps {
  height?: number | string;
  className?: string;
  initialTarget?: string;
  onReady?: (aladin: AladinInstance) => void;
}

export function AladinLite({
  height = 500,
  className = "",
  initialTarget = "M31",
  onReady,
}: AladinLiteProps) {
  // Use height prop if provided, otherwise rely on className for sizing
  const heightStyle = height ? { height, minHeight: height } : {};
  const divRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initAttempted = useRef(false);
  const [survey, setSurvey] = useState("P/DSS2/color");
  const [fov, setFov] = useState(60);

  // Load Aladin Lite script and CSS
  useEffect(() => {
    if (window.A) {
      setIsLoaded(true);
      return;
    }

    // Load CSS first
    const existingLink = document.querySelector('link[href*="aladin"]');
    if (!existingLink) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";
      document.head.appendChild(link);
    }

    // Then load script
    const existingScript = document.querySelector('script[src*="aladin"]');
    if (existingScript) {
      // Script already exists, wait for it
      const checkLoaded = setInterval(() => {
        if (window.A) {
          setIsLoaded(true);
          clearInterval(checkLoaded);
        }
      }, 100);
      return () => clearInterval(checkLoaded);
    }

    const script = document.createElement("script");
    script.src = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
    script.async = true;
    script.charset = "utf-8";
    script.onload = () => {
      // Give Aladin a moment to initialize
      setTimeout(() => setIsLoaded(true), 100);
    };
    script.onerror = (e) => {
      console.error("Failed to load Aladin Lite script:", e);
      setLoadError("Failed to load Aladin Lite script from CDN");
    };
    document.head.appendChild(script);

    return () => {
      // Don't remove script as it may be used by other components
    };
  }, []);

  // Initialize Aladin Lite
  useEffect(() => {
    if (!isLoaded || !divRef.current || aladinRef.current || initAttempted.current) return;

    initAttempted.current = true;

    if (!window.A) {
      console.error("Aladin Lite not available");
      setLoadError("Aladin Lite library not available");
      return;
    }

    const initAladin = async () => {
      try {
        // Aladin Lite v3 requires async initialization for WASM
        await window.A.init;

        aladinRef.current = window.A.aladin(divRef.current!, {
          survey,
          fov,
          target: initialTarget,
          cooFrame: "ICRS",
          showReticle: true,
          showZoomControl: true,
          showFullscreenControl: true,
          showLayersControl: true,
          showGotoControl: true,
          showShareControl: false,
          reticleColor: "#ff0000",
          reticleSize: 22,
        });

        if (onReady && aladinRef.current) {
          onReady(aladinRef.current);
        }
      } catch (error) {
        console.error("Error initializing Aladin Lite:", error);
        setLoadError(`Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    initAladin();
    // Only depend on isLoaded - other props are used once at init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  const changeSurvey = (newSurvey: string) => {
    setSurvey(newSurvey);
    aladinRef.current?.setImageSurvey(newSurvey);
  };

  const changeFov = (newFov: number) => {
    setFov(newFov);
    aladinRef.current?.setFoV(newFov);
  };

  const gotoObject = (target: string) => {
    aladinRef.current?.gotoObject(target);
  };

  const resetView = () => {
    gotoObject(initialTarget);
    changeFov(60);
  };

  if (loadError) {
    return (
      <Card className={cn("flex flex-col", className)}>
        <CardHeader className="flex-shrink-0">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            Sky Map
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex">
          <div
            className="flex-1 flex items-center justify-center border rounded-lg bg-destructive/10"
            style={heightStyle}
          >
            <div className="text-center">
              <p className="text-destructive font-medium">Failed to load sky map</p>
              <p className="text-sm text-muted-foreground mt-1">{loadError}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!isLoaded) {
    return (
      <Card className={cn("flex flex-col", className)}>
        <CardHeader className="flex-shrink-0">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            Sky Map
          </CardTitle>
        </CardHeader>
        <CardContent className="flex-1 flex">
          <div
            className="flex-1 flex items-center justify-center border rounded-lg bg-muted/50"
            style={heightStyle}
          >
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4" />
              <p className="text-muted-foreground">Loading Aladin Lite...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex-shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5" />
            Sky Map
          </CardTitle>
          <Button variant="outline" size="sm" onClick={resetView}>
            <RotateCcw className="w-4 h-4 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-4">
        {/* Aladin container */}
        <div
          ref={divRef}
          className="border rounded-lg w-full flex-1"
          style={{ ...heightStyle, position: "relative", minHeight: height || 300 }}
        />

        {/* Controls */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Survey</Label>
            <Select value={survey} onValueChange={changeSurvey}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="P/DSS2/color">DSS2 Color</SelectItem>
                <SelectItem value="P/DSS2/red">DSS2 Red</SelectItem>
                <SelectItem value="P/2MASS/color">2MASS Color</SelectItem>
                <SelectItem value="P/Mellinger/color">Mellinger</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Field of View</Label>
            <Select value={fov.toString()} onValueChange={(v) => changeFov(Number(v))}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="180">180° (All Sky)</SelectItem>
                <SelectItem value="60">60° (Wide)</SelectItem>
                <SelectItem value="30">30° (Medium)</SelectItem>
                <SelectItem value="10">10° (Narrow)</SelectItem>
                <SelectItem value="1">1° (Zoom)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Quick navigation */}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => gotoObject("M31")}>
            Andromeda
          </Button>
          <Button variant="outline" size="sm" onClick={() => gotoObject("M42")}>
            Orion Nebula
          </Button>
          <Button variant="outline" size="sm" onClick={() => gotoObject("M45")}>
            Pleiades
          </Button>
          <Button variant="outline" size="sm" onClick={() => gotoObject("M13")}>
            Hercules Cluster
          </Button>
          <Button variant="outline" size="sm" onClick={() => gotoObject("Polaris")}>
            North Star
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
