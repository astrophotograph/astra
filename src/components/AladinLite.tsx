/**
 * Aladin Lite Sky Map Component
 *
 * Interactive sky map using the Aladin Lite library from CDS.
 * Includes catalog layers, FOV overlay, and survey selection.
 */

import { useEffect, useRef, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Layers, MapPin, RotateCcw, Search, Square, Telescope } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEquipment } from "@/contexts/EquipmentContext";
import { useLocations } from "@/contexts/LocationContext";

declare global {
  interface Window {
    A: {
      init: Promise<void>;
      aladin: (element: HTMLElement, options: Record<string, unknown>) => AladinInstance;
      catalogHiPS: (url: string, options: Record<string, unknown>) => CatalogInstance;
      catalog: (options: Record<string, unknown>) => CatalogInstance;
      source: (ra: number, dec: number, data: Record<string, unknown>) => unknown;
      graphicOverlay: (options: Record<string, unknown>) => OverlayInstance;
      polygon: (coords: number[][], options: Record<string, unknown>) => unknown;
    };
  }
}

interface CatalogInstance {
  show: () => void;
  hide: () => void;
  addSources: (sources: unknown[]) => void;
}

interface OverlayInstance {
  add: (shape: unknown) => void;
  addFootprints: (footprints: unknown) => void;
  removeAll: () => void;
}

interface AladinInstance {
  setImageSurvey: (survey: string) => void;
  setFoV: (fov: number) => void;
  gotoObject: (target: string) => void;
  gotoRaDec: (ra: number, dec: number) => void;
  getRaDec: () => [number, number];
  addCatalog: (catalog: CatalogInstance) => void;
  addOverlay: (overlay: OverlayInstance) => void;
  removeOverlay: (overlay: OverlayInstance) => void;
  on: (event: string, callback: (e: { ra?: number; dec?: number }) => void) => void;
}

export interface TargetInfo {
  name: string;
  ra: number;
  dec: number;
}

interface AladinLiteProps {
  height?: number | string;
  className?: string;
  initialTarget?: string;
  onReady?: (aladin: AladinInstance) => void;
  onTargetChange?: (target: TargetInfo | null) => void;
  onFovChange?: (fov: { enabled: boolean; ra?: number; dec?: number }) => void;
}

// Catalog definitions
// HiPS catalogs are loaded from CDS, JSON catalogs from local files
const CATALOG_SOURCES = {
  simbad: {
    id: "simbad",
    name: "Simbad",
    url: "https://hipscat.cds.unistra.fr/HiPSCatService/SIMBAD",
    color: "#ff9900",
    type: "hips" as const,
  },
  messier: {
    id: "messier",
    name: "Messier",
    url: "/catalogs/Messier.json",
    color: "#29a329",
    type: "json" as const,
  },
  ngc: {
    id: "ngc",
    name: "NGC",
    url: "/catalogs/OpenNGC.json",
    color: "#cccccc",
    type: "json" as const,
  },
  ic: {
    id: "ic",
    name: "IC",
    url: "/catalogs/OpenIC.json",
    color: "#aaaaaa",
    type: "json" as const,
  },
  sharpless: {
    id: "sharpless",
    name: "Sharpless",
    url: "/catalogs/Sharpless.json",
    color: "#00afff",
    type: "json" as const,
  },
  ldn: {
    id: "ldn",
    name: "LDN",
    url: "/catalogs/LDN.json",
    color: "#CBCC49",
    type: "json" as const,
  },
  lbn: {
    id: "lbn",
    name: "LBN",
    url: "/catalogs/LBN.json",
    color: "#CBCC49",
    type: "json" as const,
  },
  barnard: {
    id: "barnard",
    name: "Barnard",
    url: "/catalogs/Barnard.json",
    color: "#E0FFFF",
    type: "json" as const,
  },
} as const;

// Hours to degrees conversion for RA
const HOURS_TO_DEG = 15;

// FOV presets
const FOV_PRESETS = [
  { id: "dslr", name: "DSLR (34×23)", width: 34, height: 23 },
  { id: "ccd", name: "CCD (17×13)", width: 17, height: 13 },
  { id: "smallccd", name: "Small CCD (7×5)", width: 7, height: 5 },
  { id: "binoculars", name: "Binoculars (60×40)", width: 60, height: 40 },
  { id: "seestar", name: "Seestar S50 (42×78)", width: 42, height: 78 },
  { id: "svbony", name: "SVBony 105 (78×60)", width: 78, height: 60 },
];

/**
 * Calculate field of view in arcminutes from sensor size and focal length
 * FOV (arcmin) = (sensor_size_mm / focal_length_mm) * 3438
 * where 3438 = 180 * 60 / π (radians to arcminutes conversion)
 */
function calculateFovArcmin(sensorSizeMm: number, focalLengthMm: number): number {
  return (sensorSizeMm / focalLengthMm) * 3438;
}

interface EquipmentFovPreset {
  id: string;
  name: string;
  width: number;  // arcminutes
  height: number; // arcminutes
  equipmentId: string;
}

export function AladinLite({
  height = 500,
  className = "",
  initialTarget = "M31",
  onReady,
  onTargetChange,
  onFovChange,
}: AladinLiteProps) {
  const heightStyle = height ? { height, minHeight: height } : {};
  const divRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initAttempted = useRef(false);
  const [survey, setSurvey] = useState("P/DSS2/color");
  const [fov, setFov] = useState(60);
  const [searchQuery, setSearchQuery] = useState("");

  // Equipment context for FOV calculation
  const { equipmentSets } = useEquipment();
  const { activeLocation } = useLocations();

  // Calculate equipment FOV presets from equipment sets
  const equipmentFovPresets = useMemo((): EquipmentFovPreset[] => {
    const presets: EquipmentFovPreset[] = [];

    // Get equipment IDs associated with active location
    const locationEquipmentIds = activeLocation?.equipmentIds || [];

    for (const equipment of equipmentSets) {
      // Only include equipment that has both telescope focal length and camera sensor size
      const focalLength = equipment.telescope?.focalLength;
      const sensorWidth = equipment.camera?.sensorWidth;
      const sensorHeight = equipment.camera?.sensorHeight;

      if (focalLength && sensorWidth && sensorHeight) {
        const widthArcmin = calculateFovArcmin(sensorWidth, focalLength);
        const heightArcmin = calculateFovArcmin(sensorHeight, focalLength);

        // Mark if this equipment is associated with current location
        const isLocationEquipment = locationEquipmentIds.includes(equipment.id);
        const prefix = isLocationEquipment ? "★ " : "";

        presets.push({
          id: `equipment-${equipment.id}`,
          name: `${prefix}${equipment.name} (${Math.round(widthArcmin)}×${Math.round(heightArcmin)}')`,
          width: Math.round(widthArcmin),
          height: Math.round(heightArcmin),
          equipmentId: equipment.id,
        });
      }
    }

    // Sort with location equipment first
    return presets.sort((a, b) => {
      const aIsLocal = locationEquipmentIds.includes(a.equipmentId);
      const bIsLocal = locationEquipmentIds.includes(b.equipmentId);
      if (aIsLocal && !bIsLocal) return -1;
      if (!aIsLocal && bIsLocal) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [equipmentSets, activeLocation]);

  // Catalog states
  const [catalogStates, setCatalogStates] = useState<Record<string, boolean>>({
    simbad: false,
    messier: false,
    ngc: false,
    ic: false,
    sharpless: false,
    ldn: false,
    lbn: false,
    barnard: false,
  });
  const catalogRefs = useRef<Record<string, CatalogInstance | null>>({});
  const [catalogsLoading, setCatalogsLoading] = useState<Record<string, boolean>>({});

  // FOV overlay state
  const [showFov, setShowFov] = useState(false);
  const [fovWidth, setFovWidth] = useState(42); // arcminutes
  const [fovHeight, setFovHeight] = useState(78); // arcminutes
  const [fovCenterRa, setFovCenterRa] = useState<number | null>(null);
  const [fovCenterDec, setFovCenterDec] = useState<number | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>("seestar");
  const [fovExpanded, setFovExpanded] = useState(false);
  const fovOverlayRef = useRef<OverlayInstance | null>(null);
  const showFovRef = useRef(false);
  const fovWidthRef = useRef(42);
  const fovHeightRef = useRef(78);

  // Load Aladin Lite script and CSS
  useEffect(() => {
    if (window.A) {
      setIsLoaded(true);
      return;
    }

    const existingLink = document.querySelector('link[href*="aladin"]');
    if (!existingLink) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector('script[src*="aladin"]');
    if (existingScript) {
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
      setTimeout(() => setIsLoaded(true), 100);
    };
    script.onerror = (e) => {
      console.error("Failed to load Aladin Lite script:", e);
      setLoadError("Failed to load Aladin Lite script from CDN");
    };
    document.head.appendChild(script);

    return () => {};
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

        // Add click handler for FOV repositioning
        aladinRef.current.on("click", (e) => {
          if (showFovRef.current && e?.ra != null && e?.dec != null) {
            updateFovPosition(e.ra, e.dec);
          }
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim() && aladinRef.current) {
      const targetName = searchQuery.trim();
      aladinRef.current.gotoObject(targetName);
      // After navigation completes, get the resolved coordinates
      setTimeout(() => {
        if (aladinRef.current) {
          const [ra, dec] = aladinRef.current.getRaDec();
          const target: TargetInfo = { name: targetName, ra, dec };
          onTargetChange?.(target);
        }
      }, 500);
    }
  };

  // Helper to convert catalog JSON entry to data object
  const catalogToDataObject = (target: unknown[]) => {
    const catname = target[0] as string;
    const extname = target[7] as string;
    const dispname = extname ? `${catname}, ${extname}` : catname;
    const size = target.length > 9 ? target[9] : 0;
    return {
      name: dispname,
      wikiname: catname,
      info: {
        radec: `${(target[1] as number).toFixed(5)} ${(target[2] as number).toFixed(5)}`,
        type: target[3],
        constellation: target[4],
        mag: target[5],
        size: size,
        distance: target[6],
        notes: target[8],
      },
    };
  };

  // Load JSON catalog
  const loadJsonCatalog = async (catalogId: keyof typeof CATALOG_SOURCES) => {
    if (!aladinRef.current || !window.A) return null;

    const catalogInfo = CATALOG_SOURCES[catalogId];
    if (catalogInfo.type !== "json") return null;

    setCatalogsLoading((prev) => ({ ...prev, [catalogId]: true }));

    try {
      const response = await fetch(catalogInfo.url);
      const data = await response.json();

      const cat = window.A.catalog({
        id: catalogInfo.id,
        name: catalogInfo.name,
        labelColumn: "name",
        displayLabel: true,
        labelColor: catalogInfo.color,
        labelFont: "12px sans-serif",
        color: catalogInfo.color,
        sourceSize: 10,
        shape: "circle",
      });

      // Add sources from JSON
      for (const target of data.data) {
        const raInDeg = (target[1] as number) * HOURS_TO_DEG;
        const dec = target[2] as number;
        cat.addSources([window.A.source(raInDeg, dec, catalogToDataObject(target))]);
      }

      aladinRef.current.addCatalog(cat);
      cat.hide(); // Start hidden
      return cat;
    } catch (error) {
      console.error(`Error loading JSON catalog ${catalogId}:`, error);
      return null;
    } finally {
      setCatalogsLoading((prev) => ({ ...prev, [catalogId]: false }));
    }
  };

  // Toggle catalog visibility
  const toggleCatalog = async (catalogId: keyof typeof CATALOG_SOURCES) => {
    const newState = !catalogStates[catalogId];
    setCatalogStates((prev) => ({ ...prev, [catalogId]: newState }));

    if (!aladinRef.current || !window.A) return;

    const catalog = CATALOG_SOURCES[catalogId];

    if (newState) {
      // Create catalog if it doesn't exist
      if (!catalogRefs.current[catalogId]) {
        try {
          if (catalog.type === "hips") {
            const cat = window.A.catalogHiPS(catalog.url, {
              id: catalog.id,
              name: catalog.name,
              color: catalog.color,
              sourceSize: 8,
              shape: "circle",
              onClick: "showTable",
            });
            aladinRef.current.addCatalog(cat);
            catalogRefs.current[catalogId] = cat;
          } else if (catalog.type === "json") {
            const cat = await loadJsonCatalog(catalogId);
            if (cat) {
              catalogRefs.current[catalogId] = cat;
            } else {
              setCatalogStates((prev) => ({ ...prev, [catalogId]: false }));
              return;
            }
          }
        } catch (error) {
          console.error(`Error creating catalog ${catalogId}:`, error);
          setCatalogStates((prev) => ({ ...prev, [catalogId]: false }));
          return;
        }
      }
      catalogRefs.current[catalogId]?.show();
    } else {
      catalogRefs.current[catalogId]?.hide();
    }
  };

  // Update FOV position
  const updateFovPosition = (ra?: number, dec?: number) => {
    if (!aladinRef.current || !window.A) return;

    const targetRa = ra ?? aladinRef.current.getRaDec()[0];
    const targetDec = dec ?? aladinRef.current.getRaDec()[1];

    setFovCenterRa(targetRa);
    setFovCenterDec(targetDec);

    // Notify parent about position change
    if (showFovRef.current) {
      onFovChange?.({ enabled: true, ra: targetRa, dec: targetDec });
    }

    // Remove existing overlay
    if (fovOverlayRef.current) {
      try {
        aladinRef.current.removeOverlay(fovOverlayRef.current);
        fovOverlayRef.current = null;
      } catch (error) {
        console.error("Error removing FOV overlay:", error);
      }
    }

    // Create new overlay
    try {
      const widthDeg = fovWidthRef.current / 60;
      const heightDeg = fovHeightRef.current / 60;

      const overlay = window.A.graphicOverlay({
        color: "#ff0000",
        lineWidth: 2,
        name: "Camera FOV",
      });

      const halfWidth = widthDeg / 2;
      const halfHeight = heightDeg / 2;

      const fovRect = window.A.polygon(
        [
          [targetRa - halfWidth, targetDec + halfHeight],
          [targetRa + halfWidth, targetDec + halfHeight],
          [targetRa + halfWidth, targetDec - halfHeight],
          [targetRa - halfWidth, targetDec - halfHeight],
        ],
        {
          color: "#ff0000",
          lineWidth: 2,
          fillColor: "#ff0000",
          fillOpacity: 0.1,
        }
      );

      overlay.addFootprints(fovRect);
      aladinRef.current.addOverlay(overlay);
      fovOverlayRef.current = overlay;
    } catch (error) {
      console.error("Error creating FOV overlay:", error);
    }
  };

  // Toggle FOV visibility
  const toggleFov = (enabled: boolean) => {
    setShowFov(enabled);
    showFovRef.current = enabled;

    if (enabled) {
      setFovExpanded(true);
      setTimeout(() => {
        updateFovPosition();
        // Notify parent about FOV state
        if (aladinRef.current) {
          const [ra, dec] = aladinRef.current.getRaDec();
          onFovChange?.({ enabled: true, ra, dec });
        }
      }, 50);
    } else {
      if (fovOverlayRef.current && aladinRef.current) {
        try {
          aladinRef.current.removeOverlay(fovOverlayRef.current);
          fovOverlayRef.current = null;
          setFovCenterRa(null);
          setFovCenterDec(null);
        } catch (error) {
          console.error("Error removing FOV overlay:", error);
        }
      }
      onFovChange?.({ enabled: false });
    }
  };

  // Update FOV size
  const updateFovSize = (width?: number, height?: number) => {
    if (width !== undefined) {
      setFovWidth(width);
      fovWidthRef.current = width;
    }
    if (height !== undefined) {
      setFovHeight(height);
      fovHeightRef.current = height;
    }
    if (showFov) {
      updateFovPosition(fovCenterRa ?? undefined, fovCenterDec ?? undefined);
    }
  };

  // Apply FOV preset
  const applyPreset = (preset: typeof FOV_PRESETS[number]) => {
    setActivePreset(preset.id);
    setFovWidth(preset.width);
    setFovHeight(preset.height);
    fovWidthRef.current = preset.width;
    fovHeightRef.current = preset.height;
    if (showFov) {
      updateFovPosition(fovCenterRa ?? undefined, fovCenterDec ?? undefined);
    }
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
    <Card className={cn("flex flex-col overflow-hidden", className)}>
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
      <CardContent className="flex-1 flex flex-col space-y-4 overflow-y-auto">
        {/* Aladin container */}
        <div
          ref={divRef}
          className="border rounded-lg w-full flex-1"
          style={{ ...heightStyle, position: "relative", minHeight: height || 300 }}
        />

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="flex-1">
            <Input
              placeholder="Search for object (e.g., M51, NGC 7000, Vega...)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" size="icon">
            <Search className="w-4 h-4" />
          </Button>
        </form>

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
                <SelectItem value="https://www.simg.de/nebulae3/dr0_2/rgb8/">NSNS DR0.2 RGB</SelectItem>
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

        {/* Catalog Layers */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            <Label className="font-medium">Catalog Layers</Label>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {Object.entries(CATALOG_SOURCES).map(([id, catalog]) => {
              const isEnabled = catalogStates[id];
              const isLoading = catalogsLoading[id];
              return (
                <div
                  key={id}
                  className={cn(
                    "flex items-center justify-between p-2 rounded-md transition-colors border",
                    isEnabled ? "bg-muted/50 border-primary/30" : "bg-muted/20 border-transparent"
                  )}
                >
                  <div className="flex items-center gap-2">
                    {isLoading ? (
                      <div className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: catalog.color, borderTopColor: 'transparent' }} />
                    ) : (
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: catalog.color }}
                      />
                    )}
                    <Label htmlFor={`catalog-${id}`} className="text-sm cursor-pointer">
                      {catalog.name}
                    </Label>
                  </div>
                  <Switch
                    id={`catalog-${id}`}
                    checked={isEnabled}
                    disabled={isLoading}
                    onCheckedChange={() => toggleCatalog(id as keyof typeof CATALOG_SOURCES)}
                  />
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            Toggle astronomical catalogs and overlays on the sky map
          </p>
        </div>

        {/* Telescope FOV */}
        <Collapsible open={fovExpanded} onOpenChange={setFovExpanded}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Telescope className="w-4 h-4" />
              <Label className="font-medium">Telescope Field of View</Label>
            </div>
            <div
              className={cn(
                "flex items-center justify-between p-2 rounded-md transition-colors border",
                showFov ? "bg-red-950/30 border-red-500/30" : "bg-muted/20 border-transparent"
              )}
            >
              <CollapsibleTrigger asChild>
                <div className="flex items-center gap-2 cursor-pointer flex-1">
                  <Square className="w-3 h-3 text-red-500" />
                  <Label className="text-sm cursor-pointer">Show FOV Rectangle</Label>
                  <ChevronDown className={cn("w-4 h-4 transition-transform", fovExpanded && "rotate-180")} />
                </div>
              </CollapsibleTrigger>
              <Switch
                checked={showFov}
                onCheckedChange={toggleFov}
              />
            </div>

            <CollapsibleContent>
              <div className="pl-4 space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">
                  Display a red rectangle showing your telescope's field of view. Click anywhere on the sky map to move the FOV rectangle.
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="fov-width" className="text-xs">
                      Width (arcmin)
                    </Label>
                    <Input
                      id="fov-width"
                      type="number"
                      min="1"
                      max="180"
                      value={fovWidth}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setActivePreset(null);
                        updateFovSize(val, undefined);
                      }}
                      className="mt-1 h-8"
                    />
                  </div>
                  <div>
                    <Label htmlFor="fov-height" className="text-xs">
                      Height (arcmin)
                    </Label>
                    <Input
                      id="fov-height"
                      type="number"
                      min="1"
                      max="180"
                      value={fovHeight}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setActivePreset(null);
                        updateFovSize(undefined, val);
                      }}
                      className="mt-1 h-8"
                    />
                  </div>
                </div>

                <div>
                  {/* Equipment-based FOV presets */}
                  {equipmentFovPresets.length > 0 && (
                    <div className="mb-2">
                      <Label className="text-xs text-muted-foreground">Your Equipment:</Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {equipmentFovPresets.map((preset) => (
                          <Button
                            key={preset.id}
                            variant={activePreset === preset.id ? "default" : "outline"}
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => applyPreset(preset)}
                          >
                            {preset.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  <Label className="text-xs text-muted-foreground">Generic Presets:</Label>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {FOV_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        variant={activePreset === preset.id ? "default" : "outline"}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => applyPreset(preset)}
                      >
                        {preset.name}
                      </Button>
                    ))}
                  </div>
                </div>

                {fovCenterRa !== null && fovCenterDec !== null && (
                  <div className="p-2 bg-muted/30 rounded-md">
                    <Label className="text-xs text-muted-foreground">FOV Center:</Label>
                    <div className="grid grid-cols-2 gap-2 mt-1 text-xs">
                      <div>
                        <span className="text-muted-foreground">RA:</span> {fovCenterRa.toFixed(4)}°
                      </div>
                      <div>
                        <span className="text-muted-foreground">Dec:</span> {fovCenterDec.toFixed(4)}°
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

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
          <Button variant="outline" size="sm" onClick={() => gotoObject("Vega")}>
            Vega
          </Button>
        </div>

        {/* Instructions */}
        <div className="text-xs text-muted-foreground space-y-1 border-t pt-3 pb-2">
          <p>• <strong>Mouse:</strong> Left-click and drag to pan, scroll to zoom</p>
          <p>• <strong>Right-click:</strong> Context menu with object information</p>
          <p>• <strong>FOV Rectangle:</strong> Click on map to reposition when enabled</p>
        </div>
      </CardContent>
    </Card>
  );
}
