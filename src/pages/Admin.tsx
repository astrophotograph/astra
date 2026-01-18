/**
 * Settings Page - Location management, backups, and app configuration
 */

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import equipmentCatalog from "@/data/equipment-catalog.json";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Settings,
  Database,
  Info,
  MapPin,
  Download,
  Upload,
  Trash2,
  RefreshCw,
  HardDrive,
  Compass,
  Mountain,
  FileUp,
  Plus,
  Check,
  Edit2,
  Telescope,
  Camera as CameraIcon,
  Crosshair,
  Circle,
  Search,
  Eye,
  EyeOff,
} from "lucide-react";
import { appApi, backupApi, type BackupInfo } from "@/lib/tauri/commands";
import {
  parseHorizonFile,
  type HorizonProfile,
  type ObserverLocation,
  type EquipmentSet,
  type Telescope as TelescopeType,
  type Mount as MountType,
  type Camera as CameraType,
  type Filter as FilterType,
  type GuideScope as GuideScopeType,
  type GuideCamera as GuideCameraType,
} from "@/lib/astronomy-utils";
import { useLocations } from "@/contexts/LocationContext";
import { useEquipment } from "@/contexts/EquipmentContext";
import { MoonPhase } from "@/components/MoonPhase";
import { getCurrentPosition } from "@tauri-apps/plugin-geolocation";

interface AppInfo {
  name: string;
  version: string;
  description: string;
}

// Equipment presets for common smart telescopes
interface EquipmentPreset {
  id: string;
  name: string;
  telescope: { name: string; aperture: string; focalLength: string; type: string };
  mount: { name: string; type: string };
  camera: { name: string; sensorWidth: string; sensorHeight: string; pixelSize: string; resolution: string };
  filters: string;
}

const EQUIPMENT_PRESETS: EquipmentPreset[] = [
  {
    id: "seestar-s50",
    name: "ZWO Seestar S50",
    telescope: { name: "Seestar S50 APO", aperture: "50", focalLength: "250", type: "Triplet APO (ED)" },
    mount: { name: "Seestar S50 Alt-Az", type: "Alt-Az" },
    camera: { name: "Sony IMX462", sensorWidth: "5.6", sensorHeight: "3.2", pixelSize: "2.9", resolution: "1920 x 1080" },
    filters: "IR-Cut, LP",
  },
  {
    id: "seestar-s30",
    name: "ZWO Seestar S30",
    telescope: { name: "Seestar S30 APO", aperture: "30", focalLength: "150", type: "Triplet APO (ED)" },
    mount: { name: "Seestar S30 Alt-Az", type: "Alt-Az" },
    camera: { name: "Sony IMX662", sensorWidth: "5.6", sensorHeight: "3.2", pixelSize: "2.9", resolution: "1920 x 1080" },
    filters: "IR-Cut, LP",
  },
  {
    id: "seestar-s30-pro",
    name: "ZWO Seestar S30 Pro",
    telescope: { name: "Seestar S30 Pro APO", aperture: "30", focalLength: "160", type: "Quadruplet APO (ED)" },
    mount: { name: "Seestar S30 Pro Alt-Az", type: "Alt-Az" },
    camera: { name: "Sony IMX585", sensorWidth: "11.1", sensorHeight: "6.3", pixelSize: "2.9", resolution: "3856 x 2180" },
    filters: "IR-Cut, LP, Dual-Band",
  },
];

export default function AdminPage() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

  // Location management
  const {
    locations,
    activeLocation,
    setActiveLocationId,
    addLocation,
    updateLocation,
    deleteLocation,
  } = useLocations();

  // Equipment management
  const {
    equipmentSets,
    addEquipmentSet,
    updateEquipmentSet,
    deleteEquipmentSet,
  } = useEquipment();

  // New/Edit location dialog
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [locationForm, setLocationForm] = useState({
    name: "",
    latitude: "",
    longitude: "",
    horizonText: "",
    equipmentIds: [] as string[],
  });

  // New/Edit equipment dialog
  const [equipmentDialogOpen, setEquipmentDialogOpen] = useState(false);
  const [editingEquipmentId, setEditingEquipmentId] = useState<string | null>(null);
  const [equipmentForm, setEquipmentForm] = useState({
    name: "",
    telescope: { name: "", aperture: "", focalLength: "", type: "" },
    mount: { name: "", type: "" },
    camera: { name: "", sensorWidth: "", sensorHeight: "", pixelSize: "", resolution: "" },
    filters: "",  // Comma-separated filter names
    guideScope: { name: "", aperture: "", focalLength: "" },
    guideCamera: { name: "", pixelSize: "" },
  });

  // Equipment catalog search
  const [telescopeSearch, setTelescopeSearch] = useState("");
  const [cameraSearch, setCameraSearch] = useState("");
  const [mountSearch, setMountSearch] = useState("");

  // Filtered catalog results
  const filteredTelescopes = useMemo(() => {
    if (!telescopeSearch.trim()) return [];
    const search = telescopeSearch.toLowerCase();
    return equipmentCatalog.telescopes
      .filter(t =>
        t.name.toLowerCase().includes(search) ||
        t.brand.toLowerCase().includes(search) ||
        t.model.toLowerCase().includes(search)
      )
      .slice(0, 8);
  }, [telescopeSearch]);

  const filteredCameras = useMemo(() => {
    if (!cameraSearch.trim()) return [];
    const search = cameraSearch.toLowerCase();
    return equipmentCatalog.cameras
      .filter(c =>
        c.name.toLowerCase().includes(search) ||
        c.brand.toLowerCase().includes(search) ||
        c.model.toLowerCase().includes(search)
      )
      .slice(0, 8);
  }, [cameraSearch]);

  const filteredMounts = useMemo(() => {
    if (!mountSearch.trim()) return [];
    const search = mountSearch.toLowerCase();
    return equipmentCatalog.mounts
      .filter(m =>
        m.name.toLowerCase().includes(search) ||
        m.brand.toLowerCase().includes(search) ||
        m.model.toLowerCase().includes(search)
      )
      .slice(0, 8);
  }, [mountSearch]);

  // Plate solving settings
  const [plateSolveSolver, setPlateSolveSolver] = useState(() =>
    localStorage.getItem("plate_solve_solver") || "nova"
  );
  const [astrometryApiKey, setAstrometryApiKey] = useState(() =>
    localStorage.getItem("astrometry_api_key") || ""
  );
  const [localAstrometryUrl, setLocalAstrometryUrl] = useState(() =>
    localStorage.getItem("local_astrometry_url") || ""
  );
  const [showApiKey, setShowApiKey] = useState(false);

  // Load app info and backups
  useEffect(() => {
    appApi.getInfo().then(setAppInfo).catch(console.error);
    loadBackups();
  }, []);

  // Load backups list
  const loadBackups = async () => {
    setIsLoadingBackups(true);
    try {
      const backupList = await backupApi.list();
      setBackups(backupList);
    } catch (err) {
      console.error("Failed to load backups:", err);
    } finally {
      setIsLoadingBackups(false);
    }
  };

  // Create backup
  const handleCreateBackup = async () => {
    setIsCreatingBackup(true);
    try {
      const result = await backupApi.create();
      if (result.success) {
        toast.success("Backup created successfully");
        loadBackups();
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error("Failed to create backup");
      console.error(err);
    } finally {
      setIsCreatingBackup(false);
    }
  };

  // Restore backup
  const handleRestoreBackup = async () => {
    if (!selectedBackup) return;

    setIsRestoring(true);
    try {
      const result = await backupApi.restore(selectedBackup.path);
      if (result.success) {
        toast.success("Database restored successfully. Please restart the app.");
        setRestoreDialogOpen(false);
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error("Failed to restore backup");
      console.error(err);
    } finally {
      setIsRestoring(false);
    }
  };

  // Delete backup
  const handleDeleteBackup = async (backup: BackupInfo) => {
    try {
      const result = await backupApi.delete(backup.path);
      if (result.success) {
        toast.success("Backup deleted");
        loadBackups();
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error("Failed to delete backup");
      console.error(err);
    }
  };

  // Open dialog to add new location
  const openAddLocationDialog = () => {
    setEditingLocationId(null);
    setLocationForm({
      name: "",
      latitude: "",
      longitude: "",
      horizonText: "",
      equipmentIds: [],
    });
    setLocationDialogOpen(true);
  };

  // Open dialog to edit existing location
  const openEditLocationDialog = (location: ObserverLocation) => {
    setEditingLocationId(location.id);
    setLocationForm({
      name: location.name,
      latitude: location.latitude.toString(),
      longitude: location.longitude.toString(),
      horizonText: location.horizon?.points
        .map((p) => `${p.azimuth} ${p.altitude}`)
        .join("\n") || "",
      equipmentIds: location.equipmentIds || [],
    });
    setLocationDialogOpen(true);
  };

  // Open dialog to add new equipment
  const openAddEquipmentDialog = () => {
    setEditingEquipmentId(null);
    setEquipmentForm({
      name: "",
      telescope: { name: "", aperture: "", focalLength: "", type: "" },
      mount: { name: "", type: "" },
      camera: { name: "", sensorWidth: "", sensorHeight: "", pixelSize: "", resolution: "" },
      filters: "",
      guideScope: { name: "", aperture: "", focalLength: "" },
      guideCamera: { name: "", pixelSize: "" },
    });
    setEquipmentDialogOpen(true);
  };

  // Open dialog to edit existing equipment
  const openEditEquipmentDialog = (equipment: EquipmentSet) => {
    setEditingEquipmentId(equipment.id);
    setEquipmentForm({
      name: equipment.name,
      telescope: {
        name: equipment.telescope?.name || "",
        aperture: equipment.telescope?.aperture?.toString() || "",
        focalLength: equipment.telescope?.focalLength?.toString() || "",
        type: equipment.telescope?.type || "",
      },
      mount: {
        name: equipment.mount?.name || "",
        type: equipment.mount?.type || "",
      },
      camera: {
        name: equipment.camera?.name || "",
        sensorWidth: equipment.camera?.sensorWidth?.toString() || "",
        sensorHeight: equipment.camera?.sensorHeight?.toString() || "",
        pixelSize: equipment.camera?.pixelSize?.toString() || "",
        resolution: equipment.camera?.resolution || "",
      },
      filters: equipment.filters?.map(f => f.name).join(", ") || "",
      guideScope: {
        name: equipment.guideScope?.name || "",
        aperture: equipment.guideScope?.aperture?.toString() || "",
        focalLength: equipment.guideScope?.focalLength?.toString() || "",
      },
      guideCamera: {
        name: equipment.guideCamera?.name || "",
        pixelSize: equipment.guideCamera?.pixelSize?.toString() || "",
      },
    });
    setEquipmentDialogOpen(true);
  };

  // Get current location using Tauri geolocation plugin
  const autoDetectLocation = async () => {
    try {
      const position = await getCurrentPosition();
      setLocationForm((prev) => ({
        ...prev,
        latitude: position.coords.latitude.toString(),
        longitude: position.coords.longitude.toString(),
      }));
      toast.success("Location detected");
    } catch (error) {
      console.error("Geolocation error:", error);
      toast.error(`Location error: ${String(error)}`);
    }
  };

  // Handle horizon file upload in dialog
  const handleHorizonFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setLocationForm((prev) => ({ ...prev, horizonText: text }));
      const profile = parseHorizonFile(text);
      toast.success(`Loaded ${profile.points.length} horizon points`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Save location (add or update)
  const handleSaveLocation = () => {
    const lat = parseFloat(locationForm.latitude);
    const lng = parseFloat(locationForm.longitude);

    if (!locationForm.name.trim()) {
      toast.error("Please enter a location name");
      return;
    }
    if (isNaN(lat) || lat < -90 || lat > 90) {
      toast.error("Please enter a valid latitude (-90 to 90)");
      return;
    }
    if (isNaN(lng) || lng < -180 || lng > 180) {
      toast.error("Please enter a valid longitude (-180 to 180)");
      return;
    }

    const horizon: HorizonProfile | undefined = locationForm.horizonText.trim()
      ? parseHorizonFile(locationForm.horizonText)
      : undefined;

    if (editingLocationId) {
      updateLocation(editingLocationId, {
        name: locationForm.name,
        latitude: lat,
        longitude: lng,
        horizon,
        equipmentIds: locationForm.equipmentIds.length > 0 ? locationForm.equipmentIds : undefined,
      });
      toast.success("Location updated");
    } else {
      addLocation({
        name: locationForm.name,
        latitude: lat,
        longitude: lng,
        horizon,
        equipmentIds: locationForm.equipmentIds.length > 0 ? locationForm.equipmentIds : undefined,
      });
      toast.success("Location added");
    }

    setLocationDialogOpen(false);
  };

  // Save equipment (add or update)
  const handleSaveEquipment = () => {
    if (!equipmentForm.name.trim()) {
      toast.error("Please enter an equipment set name");
      return;
    }

    // Build telescope object if any fields are filled
    const telescope: TelescopeType | undefined = equipmentForm.telescope.name.trim()
      ? {
          name: equipmentForm.telescope.name,
          aperture: equipmentForm.telescope.aperture ? parseFloat(equipmentForm.telescope.aperture) : undefined,
          focalLength: equipmentForm.telescope.focalLength ? parseFloat(equipmentForm.telescope.focalLength) : undefined,
          type: equipmentForm.telescope.type || undefined,
        }
      : undefined;

    // Build mount object if any fields are filled
    const mount: MountType | undefined = equipmentForm.mount.name.trim()
      ? {
          name: equipmentForm.mount.name,
          type: equipmentForm.mount.type || undefined,
        }
      : undefined;

    // Build camera object if any fields are filled
    const camera: CameraType | undefined = equipmentForm.camera.name.trim()
      ? {
          name: equipmentForm.camera.name,
          sensorWidth: equipmentForm.camera.sensorWidth ? parseFloat(equipmentForm.camera.sensorWidth) : undefined,
          sensorHeight: equipmentForm.camera.sensorHeight ? parseFloat(equipmentForm.camera.sensorHeight) : undefined,
          pixelSize: equipmentForm.camera.pixelSize ? parseFloat(equipmentForm.camera.pixelSize) : undefined,
          resolution: equipmentForm.camera.resolution || undefined,
        }
      : undefined;

    // Build filters array from comma-separated names
    const filters: FilterType[] | undefined = equipmentForm.filters.trim()
      ? equipmentForm.filters.split(",").map(f => ({ name: f.trim() })).filter(f => f.name)
      : undefined;

    // Build guide scope object if any fields are filled
    const guideScope: GuideScopeType | undefined = equipmentForm.guideScope.name.trim()
      ? {
          name: equipmentForm.guideScope.name,
          aperture: equipmentForm.guideScope.aperture ? parseFloat(equipmentForm.guideScope.aperture) : undefined,
          focalLength: equipmentForm.guideScope.focalLength ? parseFloat(equipmentForm.guideScope.focalLength) : undefined,
        }
      : undefined;

    // Build guide camera object if any fields are filled
    const guideCamera: GuideCameraType | undefined = equipmentForm.guideCamera.name.trim()
      ? {
          name: equipmentForm.guideCamera.name,
          pixelSize: equipmentForm.guideCamera.pixelSize ? parseFloat(equipmentForm.guideCamera.pixelSize) : undefined,
        }
      : undefined;

    if (editingEquipmentId) {
      updateEquipmentSet(editingEquipmentId, {
        name: equipmentForm.name,
        telescope,
        mount,
        camera,
        filters,
        guideScope,
        guideCamera,
      });
      toast.success("Equipment updated");
    } else {
      addEquipmentSet({
        name: equipmentForm.name,
        telescope,
        mount,
        camera,
        filters,
        guideScope,
        guideCamera,
      });
      toast.success("Equipment added");
    }

    setEquipmentDialogOpen(false);
  };

  // Delete equipment with confirmation
  const handleDeleteEquipment = (id: string) => {
    // Check if any location is using this equipment
    const usedByLocations = locations.filter(loc => loc.equipmentIds?.includes(id));
    if (usedByLocations.length > 0) {
      toast.error(`This equipment is used by ${usedByLocations.length} location(s). Remove it from locations first.`);
      return;
    }
    deleteEquipmentSet(id);
    toast.success("Equipment deleted");
  };

  // Toggle equipment association with location
  const toggleEquipmentForLocation = (equipmentId: string) => {
    setLocationForm(prev => {
      const current = prev.equipmentIds;
      if (current.includes(equipmentId)) {
        return { ...prev, equipmentIds: current.filter(id => id !== equipmentId) };
      } else {
        return { ...prev, equipmentIds: [...current, equipmentId] };
      }
    });
  };

  // Get equipment summary string
  const getEquipmentSummary = (equipment: EquipmentSet): string => {
    const parts: string[] = [];
    if (equipment.telescope) parts.push(equipment.telescope.name);
    if (equipment.camera) parts.push(equipment.camera.name);
    if (equipment.mount) parts.push(equipment.mount.name);
    return parts.length > 0 ? parts.join(" + ") : "No components defined";
  };

  // Apply equipment preset to form
  const applyEquipmentPreset = (presetId: string) => {
    const preset = EQUIPMENT_PRESETS.find(p => p.id === presetId);
    if (!preset) return;

    setEquipmentForm({
      name: preset.name,
      telescope: { ...preset.telescope },
      mount: { ...preset.mount },
      camera: { ...preset.camera },
      filters: preset.filters,
      guideScope: { name: "", aperture: "", focalLength: "" },
      guideCamera: { name: "", pixelSize: "" },
    });
    toast.success(`Applied "${preset.name}" preset`);
  };

  // Select telescope from catalog
  const selectCatalogTelescope = (telescope: typeof equipmentCatalog.telescopes[0]) => {
    setEquipmentForm((prev) => ({
      ...prev,
      telescope: {
        name: telescope.name,
        aperture: telescope.aperture.toString(),
        focalLength: telescope.focalLength.toString(),
        type: telescope.type,
      },
    }));
    setTelescopeSearch("");
    toast.success(`Selected ${telescope.name}`);
  };

  // Select camera from catalog
  const selectCatalogCamera = (camera: typeof equipmentCatalog.cameras[0]) => {
    setEquipmentForm((prev) => ({
      ...prev,
      camera: {
        name: camera.name,
        sensorWidth: camera.sensorWidth.toString(),
        sensorHeight: camera.sensorHeight.toString(),
        pixelSize: camera.pixelSize.toString(),
        resolution: camera.resolution,
      },
    }));
    setCameraSearch("");
    toast.success(`Selected ${camera.name}`);
  };

  // Select mount from catalog
  const selectCatalogMount = (mount: typeof equipmentCatalog.mounts[0]) => {
    setEquipmentForm((prev) => ({
      ...prev,
      mount: {
        name: mount.name,
        type: mount.type,
      },
    }));
    setMountSearch("");
    toast.success(`Selected ${mount.name}`);
  };

  // Delete location with confirmation
  const handleDeleteLocation = (id: string) => {
    if (locations.length === 1) {
      toast.error("Cannot delete the only location");
      return;
    }
    deleteLocation(id);
    toast.success("Location deleted");
  };

  // Get horizon stats for a location
  const getHorizonStats = (horizon?: HorizonProfile) => {
    if (!horizon?.points.length) return null;
    return {
      count: horizon.points.length,
      minAlt: Math.min(...horizon.points.map((p) => p.altitude)),
      maxAlt: Math.max(...horizon.points.map((p) => p.altitude)),
      avgAlt:
        horizon.points.reduce((sum, p) => sum + p.altitude, 0) /
        horizon.points.length,
    };
  };

  // Save plate solve solver preference
  const savePlateSolveSolver = (value: string) => {
    setPlateSolveSolver(value);
    localStorage.setItem("plate_solve_solver", value);
    toast.success("Solver preference saved");
  };

  // Save astrometry API key
  const saveAstrometryApiKey = () => {
    localStorage.setItem("astrometry_api_key", astrometryApiKey);
    toast.success("API key saved");
  };

  // Save local astrometry URL
  const saveLocalAstrometryUrl = () => {
    localStorage.setItem("local_astrometry_url", localAstrometryUrl);
    toast.success("Local API URL saved");
  };

  // Format file size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Format date
  const formatDate = (dateStr: string): string => {
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Settings className="w-8 h-8" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* Observer Locations - Full width */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="w-5 h-5" />
                Observer Locations
              </CardTitle>
              <CardDescription>
                Manage your observing locations with custom horizons
              </CardDescription>
            </div>
            <Button onClick={openAddLocationDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Add Location
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {locations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <MapPin className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No locations configured. Add your first observing location to get started.</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {locations.map((loc) => {
                const horizonStats = getHorizonStats(loc.horizon);
                const isActive = loc.id === activeLocation?.id;
                return (
                  <div
                    key={loc.id}
                    className={`p-4 border rounded-lg ${isActive ? "border-primary bg-primary/5" : "border-border"}`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-medium flex items-center gap-2">
                          {loc.name}
                          {isActive && (
                            <Badge variant="default" className="text-xs">Active</Badge>
                          )}
                        </h3>
                        <p className="text-xs text-muted-foreground font-mono">
                          {loc.latitude.toFixed(4)}°, {loc.longitude.toFixed(4)}°
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEditLocationDialog(loc)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        {!isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => handleDeleteLocation(loc.id)}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Horizon info */}
                    <div className="mb-2">
                      {horizonStats ? (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Mountain className="w-3 h-3" />
                          <span>{horizonStats.count} points, avg {horizonStats.avgAlt.toFixed(1)}°</span>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Mountain className="w-3 h-3 opacity-50" />
                          <span>No horizon profile</span>
                        </div>
                      )}
                    </div>

                    {/* Equipment info */}
                    <div className="mb-3">
                      {loc.equipmentIds && loc.equipmentIds.length > 0 ? (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Telescope className="w-3 h-3" />
                          <span>{loc.equipmentIds.length} equipment set{loc.equipmentIds.length > 1 ? "s" : ""}</span>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground flex items-center gap-2">
                          <Telescope className="w-3 h-3 opacity-50" />
                          <span>No equipment</span>
                        </div>
                      )}
                    </div>

                    {/* Set active button */}
                    {!isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setActiveLocationId(loc.id)}
                      >
                        <Check className="w-4 h-4 mr-2" />
                        Set Active
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Equipment Sets - Full width */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Telescope className="w-5 h-5" />
                Equipment Sets
              </CardTitle>
              <CardDescription>
                Define your imaging equipment configurations
              </CardDescription>
            </div>
            <Button onClick={openAddEquipmentDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Add Equipment
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {equipmentSets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Telescope className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No equipment configured. Add your first equipment set to get started.</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {equipmentSets.map((eq) => {
                const usedByCount = locations.filter(loc => loc.equipmentIds?.includes(eq.id)).length;
                return (
                  <div
                    key={eq.id}
                    className="p-4 border rounded-lg border-border"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-medium">{eq.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          {getEquipmentSummary(eq)}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEditEquipmentDialog(eq)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleDeleteEquipment(eq.id)}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    {/* Equipment details */}
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {eq.telescope && (
                        <div className="flex items-center gap-2">
                          <Telescope className="w-3 h-3" />
                          <span>{eq.telescope.name}</span>
                          {eq.telescope.aperture && <span className="opacity-60">({eq.telescope.aperture}mm)</span>}
                        </div>
                      )}
                      {eq.camera && (
                        <div className="flex items-center gap-2">
                          <CameraIcon className="w-3 h-3" />
                          <span>{eq.camera.name}</span>
                        </div>
                      )}
                      {eq.mount && (
                        <div className="flex items-center gap-2">
                          <Crosshair className="w-3 h-3" />
                          <span>{eq.mount.name}</span>
                        </div>
                      )}
                      {eq.filters && eq.filters.length > 0 && (
                        <div className="flex items-center gap-2">
                          <Circle className="w-3 h-3" />
                          <span>{eq.filters.map(f => f.name).join(", ")}</span>
                        </div>
                      )}
                      {eq.guideScope && (
                        <div className="flex items-center gap-2 opacity-60">
                          <Telescope className="w-3 h-3" />
                          <span>Guide: {eq.guideScope.name}</span>
                        </div>
                      )}
                    </div>

                    {/* Usage info */}
                    <div className="mt-3 pt-2 border-t text-xs text-muted-foreground">
                      {usedByCount > 0 ? (
                        <span>Used by {usedByCount} location{usedByCount > 1 ? "s" : ""}</span>
                      ) : (
                        <span className="opacity-50">Not assigned to any location</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* App Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="w-5 h-5" />
              Application Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {appInfo ? (
              <>
                <div>
                  <Label className="text-muted-foreground">Name</Label>
                  <p className="font-medium">{appInfo.name}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Version</Label>
                  <p>
                    <Badge variant="secondary">{appInfo.version}</Badge>
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Description</Label>
                  <p>{appInfo.description}</p>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Loading...</p>
            )}
          </CardContent>
        </Card>

        {/* Plate Solving Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Compass className="w-5 h-5" />
              Plate Solving
            </CardTitle>
            <CardDescription>
              Configure plate solving settings for image coordinate detection
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Solver</Label>
              <Select value={plateSolveSolver} onValueChange={savePlateSolveSolver}>
                <SelectTrigger>
                  <SelectValue placeholder="Select solver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nova">Nova (astrometry.net API)</SelectItem>
                  <SelectItem value="local">Local (solve-field)</SelectItem>
                  <SelectItem value="astap">ASTAP</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {plateSolveSolver === "nova" && "Uses the free nova.astrometry.net web API. Requires API key."}
                {plateSolveSolver === "local" && "Requires local astrometry.net installation with index files."}
                {plateSolveSolver === "astap" && "Requires ASTAP solver installed with star database."}
              </p>
            </div>

            {plateSolveSolver === "nova" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="api-key">Astrometry.net API Key</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="api-key"
                        type={showApiKey ? "text" : "password"}
                        value={astrometryApiKey}
                        onChange={(e) => setAstrometryApiKey(e.target.value)}
                        placeholder="Enter your API key"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? (
                          <EyeOff className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                    <Button variant="outline" onClick={saveAstrometryApiKey}>
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Get your free API key from{" "}
                    <a
                      href="https://nova.astrometry.net/api_help"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      nova.astrometry.net
                    </a>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="local-api-url">Local API URL (Optional)</Label>
                  <div className="flex gap-2">
                    <Input
                      id="local-api-url"
                      type="url"
                      value={localAstrometryUrl}
                      onChange={(e) => setLocalAstrometryUrl(e.target.value)}
                      placeholder="http://localhost:8080"
                    />
                    <Button variant="outline" onClick={saveLocalAstrometryUrl}>
                      Save
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Leave empty to use the public nova.astrometry.net server. Set this if you have a local
                    astrometry.net instance running (e.g., http://localhost:8080 or http://192.168.1.100:8080).
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Moon Phase */}
        <MoonPhase
          latitude={activeLocation?.latitude}
          longitude={activeLocation?.longitude}
        />

        {/* Database Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Database
            </CardTitle>
            <CardDescription>Local SQLite database information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Storage</Label>
              <p>SQLite (local)</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Location</Label>
              <p className="text-sm font-mono break-all">
                ~/.local/share/com.astra.app/astra.db
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Backup & Restore */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="w-5 h-5" />
              Backup & Restore
            </CardTitle>
            <CardDescription>
              Create and restore database backups
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button onClick={handleCreateBackup} disabled={isCreatingBackup}>
                <Download className="w-4 h-4 mr-2" />
                {isCreatingBackup ? "Creating..." : "Create Backup"}
              </Button>
              <Button variant="outline" onClick={loadBackups} disabled={isLoadingBackups}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isLoadingBackups ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            <div className="border rounded-lg">
              <div className="p-3 border-b bg-muted/50">
                <h4 className="font-medium">Available Backups</h4>
              </div>
              <div className="divide-y max-h-64 overflow-y-auto">
                {backups.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground">
                    {isLoadingBackups ? "Loading backups..." : "No backups available"}
                  </div>
                ) : (
                  backups.map((backup) => (
                    <div
                      key={backup.path}
                      className="p-3 flex items-center justify-between hover:bg-muted/30"
                    >
                      <div>
                        <p className="font-mono text-sm">{backup.filename}</p>
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <span>{formatSize(backup.size_bytes)}</span>
                          <span>{formatDate(backup.created_at)}</span>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedBackup(backup);
                            setRestoreDialogOpen(true);
                          }}
                        >
                          <Upload className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteBackup(backup)}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add/Edit Location Dialog */}
      <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingLocationId ? "Edit Location" : "Add Location"}
            </DialogTitle>
            <DialogDescription>
              Configure your observing location with optional horizon profile
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="loc-name">Location Name</Label>
              <Input
                id="loc-name"
                value={locationForm.name}
                onChange={(e) => setLocationForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Backyard Observatory"
                className="mt-1"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="loc-lat">Latitude</Label>
                <Input
                  id="loc-lat"
                  type="number"
                  step="0.0001"
                  min="-90"
                  max="90"
                  value={locationForm.latitude}
                  onChange={(e) => setLocationForm((prev) => ({ ...prev, latitude: e.target.value }))}
                  placeholder="e.g., 40.7128"
                  className="mt-1 font-mono"
                />
              </div>
              <div>
                <Label htmlFor="loc-lng">Longitude</Label>
                <Input
                  id="loc-lng"
                  type="number"
                  step="0.0001"
                  min="-180"
                  max="180"
                  value={locationForm.longitude}
                  onChange={(e) => setLocationForm((prev) => ({ ...prev, longitude: e.target.value }))}
                  placeholder="e.g., -74.0060"
                  className="mt-1 font-mono"
                />
              </div>
            </div>

            <Button variant="outline" onClick={autoDetectLocation} className="w-full">
              <MapPin className="w-4 h-4 mr-2" />
              Auto-detect Location
            </Button>

            <div className="pt-2 border-t">
              <div className="flex items-center justify-between mb-2">
                <Label className="flex items-center gap-2">
                  <Mountain className="w-4 h-4" />
                  Horizon Profile
                </Label>
                <label>
                  <input
                    type="file"
                    accept=".txt,.csv"
                    onChange={handleHorizonFileUpload}
                    className="hidden"
                  />
                  <Button variant="ghost" size="sm" asChild>
                    <span>
                      <FileUp className="w-4 h-4 mr-1" />
                      Upload
                    </span>
                  </Button>
                </label>
              </div>
              <textarea
                value={locationForm.horizonText}
                onChange={(e) => setLocationForm((prev) => ({ ...prev, horizonText: e.target.value }))}
                placeholder="azimuth altitude (one per line)&#10;0 5&#10;45 10&#10;90 3&#10;..."
                className="w-full h-24 p-2 text-sm font-mono bg-background border rounded-md resize-none"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Format: each line contains "azimuth altitude" in degrees (0-360, elevation above horizon)
              </p>
            </div>

            {/* Equipment selection */}
            {equipmentSets.length > 0 && (
              <div className="pt-2 border-t">
                <Label className="flex items-center gap-2 mb-2">
                  <Telescope className="w-4 h-4" />
                  Equipment Sets
                </Label>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {equipmentSets.map((eq) => (
                    <div
                      key={eq.id}
                      className={`flex items-center gap-2 p-2 border rounded cursor-pointer transition-colors ${
                        locationForm.equipmentIds.includes(eq.id)
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-muted/50"
                      }`}
                      onClick={() => toggleEquipmentForLocation(eq.id)}
                    >
                      <div className={`w-4 h-4 border rounded flex items-center justify-center ${
                        locationForm.equipmentIds.includes(eq.id) ? "bg-primary border-primary" : "border-muted-foreground"
                      }`}>
                        {locationForm.equipmentIds.includes(eq.id) && (
                          <Check className="w-3 h-3 text-primary-foreground" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{eq.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {getEquipmentSummary(eq)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Click to toggle equipment association
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLocationDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveLocation}>
              {editingLocationId ? "Save Changes" : "Add Location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Confirmation Dialog */}
      <Dialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Database</DialogTitle>
            <DialogDescription>
              Are you sure you want to restore from this backup? The current database
              will be backed up before restoring.
            </DialogDescription>
          </DialogHeader>
          {selectedBackup && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="font-mono text-sm">{selectedBackup.filename}</p>
              <p className="text-xs text-muted-foreground">
                {formatSize(selectedBackup.size_bytes)} - {formatDate(selectedBackup.created_at)}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRestoreBackup} disabled={isRestoring}>
              {isRestoring ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add/Edit Equipment Dialog */}
      <Dialog open={equipmentDialogOpen} onOpenChange={setEquipmentDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingEquipmentId ? "Edit Equipment Set" : "Add Equipment Set"}
            </DialogTitle>
            <DialogDescription>
              Define your imaging equipment configuration. All fields except name are optional.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Preset Selector - only show for new equipment */}
            {!editingEquipmentId && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <Label className="text-sm font-medium mb-2 block">Quick Start with Preset</Label>
                <Select onValueChange={applyEquipmentPreset}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a preset to populate fields..." />
                  </SelectTrigger>
                  <SelectContent>
                    {EQUIPMENT_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Choosing a preset will populate all fields below. You can then customize as needed.
                </p>
              </div>
            )}

            {/* Equipment Set Name */}
            <div>
              <Label htmlFor="eq-name">Equipment Set Name *</Label>
              <Input
                id="eq-name"
                value={equipmentForm.name}
                onChange={(e) => setEquipmentForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Main Imaging Rig"
                className="mt-1"
              />
            </div>

            {/* Telescope */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <Telescope className="w-4 h-4" />
                Telescope
              </Label>
              {/* Telescope Search */}
              <div className="mb-3 relative">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={telescopeSearch}
                    onChange={(e) => setTelescopeSearch(e.target.value)}
                    placeholder="Search catalog (e.g., RedCat, Esprit, Seestar...)"
                    className="flex-1"
                  />
                </div>
                {filteredTelescopes.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredTelescopes.map((t, i) => (
                      <button
                        key={i}
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex justify-between items-center"
                        onClick={() => selectCatalogTelescope(t)}
                      >
                        <span className="font-medium">{t.name}</span>
                        <span className="text-xs text-muted-foreground">{t.aperture}mm f/{(t.focalLength / t.aperture).toFixed(1)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="eq-telescope-name" className="text-xs">Name</Label>
                  <Input
                    id="eq-telescope-name"
                    value={equipmentForm.telescope.name}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      telescope: { ...prev.telescope, name: e.target.value }
                    }))}
                    placeholder="e.g., Celestron EdgeHD 8"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-telescope-aperture" className="text-xs">Aperture (mm)</Label>
                  <Input
                    id="eq-telescope-aperture"
                    type="number"
                    value={equipmentForm.telescope.aperture}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      telescope: { ...prev.telescope, aperture: e.target.value }
                    }))}
                    placeholder="e.g., 203"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-telescope-focal" className="text-xs">Focal Length (mm)</Label>
                  <Input
                    id="eq-telescope-focal"
                    type="number"
                    value={equipmentForm.telescope.focalLength}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      telescope: { ...prev.telescope, focalLength: e.target.value }
                    }))}
                    placeholder="e.g., 2032"
                    className="mt-1"
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="eq-telescope-type" className="text-xs">Type</Label>
                  <Input
                    id="eq-telescope-type"
                    value={equipmentForm.telescope.type}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      telescope: { ...prev.telescope, type: e.target.value }
                    }))}
                    placeholder="e.g., SCT, Refractor, Newtonian"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Mount */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <Crosshair className="w-4 h-4" />
                Mount
              </Label>
              {/* Mount Search */}
              <div className="mb-3 relative">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={mountSearch}
                    onChange={(e) => setMountSearch(e.target.value)}
                    placeholder="Search catalog (e.g., AM5, EQ6, RST...)"
                    className="flex-1"
                  />
                </div>
                {filteredMounts.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredMounts.map((m, i) => (
                      <button
                        key={i}
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex justify-between items-center"
                        onClick={() => selectCatalogMount(m)}
                      >
                        <span className="font-medium">{m.name}</span>
                        <span className="text-xs text-muted-foreground">{m.type} ({m.payload}kg)</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="eq-mount-name" className="text-xs">Name</Label>
                  <Input
                    id="eq-mount-name"
                    value={equipmentForm.mount.name}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      mount: { ...prev.mount, name: e.target.value }
                    }))}
                    placeholder="e.g., EQ6-R Pro"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-mount-type" className="text-xs">Type</Label>
                  <Input
                    id="eq-mount-type"
                    value={equipmentForm.mount.type}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      mount: { ...prev.mount, type: e.target.value }
                    }))}
                    placeholder="e.g., EQ, Alt-Az, Fork"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Camera */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <CameraIcon className="w-4 h-4" />
                Camera
              </Label>
              {/* Camera Search */}
              <div className="mb-3 relative">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    value={cameraSearch}
                    onChange={(e) => setCameraSearch(e.target.value)}
                    placeholder="Search catalog (e.g., ASI2600, Poseidon, 533...)"
                    className="flex-1"
                  />
                </div>
                {filteredCameras.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full bg-background border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredCameras.map((c, i) => (
                      <button
                        key={i}
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted flex justify-between items-center"
                        onClick={() => selectCatalogCamera(c)}
                      >
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-muted-foreground">{c.pixelSize}µm {c.resolution}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <Label htmlFor="eq-camera-name" className="text-xs">Name</Label>
                  <Input
                    id="eq-camera-name"
                    value={equipmentForm.camera.name}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, name: e.target.value }
                    }))}
                    placeholder="e.g., ZWO ASI294MC Pro"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-camera-sensor-w" className="text-xs">Sensor Width (mm)</Label>
                  <Input
                    id="eq-camera-sensor-w"
                    type="number"
                    step="0.1"
                    value={equipmentForm.camera.sensorWidth}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, sensorWidth: e.target.value }
                    }))}
                    placeholder="e.g., 23.2"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-camera-sensor-h" className="text-xs">Sensor Height (mm)</Label>
                  <Input
                    id="eq-camera-sensor-h"
                    type="number"
                    step="0.1"
                    value={equipmentForm.camera.sensorHeight}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, sensorHeight: e.target.value }
                    }))}
                    placeholder="e.g., 15.5"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-camera-pixel" className="text-xs">Pixel Size (microns)</Label>
                  <Input
                    id="eq-camera-pixel"
                    type="number"
                    step="0.01"
                    value={equipmentForm.camera.pixelSize}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, pixelSize: e.target.value }
                    }))}
                    placeholder="e.g., 4.63"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-camera-resolution" className="text-xs">Resolution</Label>
                  <Input
                    id="eq-camera-resolution"
                    value={equipmentForm.camera.resolution}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      camera: { ...prev.camera, resolution: e.target.value }
                    }))}
                    placeholder="e.g., 4144 x 2822"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <Circle className="w-4 h-4" />
                Filters
              </Label>
              <Input
                value={equipmentForm.filters}
                onChange={(e) => setEquipmentForm((prev) => ({ ...prev, filters: e.target.value }))}
                placeholder="e.g., L, R, G, B, Ha, OIII, SII"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Comma-separated list of filter names
              </p>
            </div>

            {/* Guide Scope */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <Telescope className="w-4 h-4" />
                Guide Scope
              </Label>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor="eq-guide-name" className="text-xs">Name</Label>
                  <Input
                    id="eq-guide-name"
                    value={equipmentForm.guideScope.name}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      guideScope: { ...prev.guideScope, name: e.target.value }
                    }))}
                    placeholder="e.g., ZWO 60mm"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-guide-aperture" className="text-xs">Aperture (mm)</Label>
                  <Input
                    id="eq-guide-aperture"
                    type="number"
                    value={equipmentForm.guideScope.aperture}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      guideScope: { ...prev.guideScope, aperture: e.target.value }
                    }))}
                    placeholder="e.g., 60"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-guide-focal" className="text-xs">Focal Length (mm)</Label>
                  <Input
                    id="eq-guide-focal"
                    type="number"
                    value={equipmentForm.guideScope.focalLength}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      guideScope: { ...prev.guideScope, focalLength: e.target.value }
                    }))}
                    placeholder="e.g., 228"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>

            {/* Guide Camera */}
            <div className="pt-2 border-t">
              <Label className="flex items-center gap-2 mb-3">
                <CameraIcon className="w-4 h-4" />
                Guide Camera
              </Label>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="eq-guidecam-name" className="text-xs">Name</Label>
                  <Input
                    id="eq-guidecam-name"
                    value={equipmentForm.guideCamera.name}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      guideCamera: { ...prev.guideCamera, name: e.target.value }
                    }))}
                    placeholder="e.g., ZWO ASI120MM Mini"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="eq-guidecam-pixel" className="text-xs">Pixel Size (microns)</Label>
                  <Input
                    id="eq-guidecam-pixel"
                    type="number"
                    step="0.01"
                    value={equipmentForm.guideCamera.pixelSize}
                    onChange={(e) => setEquipmentForm((prev) => ({
                      ...prev,
                      guideCamera: { ...prev.guideCamera, pixelSize: e.target.value }
                    }))}
                    placeholder="e.g., 3.75"
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEquipmentDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEquipment}>
              {editingEquipmentId ? "Save Changes" : "Add Equipment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
