/**
 * Settings Page - Location management, backups, and app configuration
 */

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";
import { appApi, backupApi, type BackupInfo } from "@/lib/tauri/commands";
import {
  parseHorizonFile,
  type HorizonProfile,
  type ObserverLocation,
} from "@/lib/astronomy-utils";
import { useLocations } from "@/contexts/LocationContext";
import { MoonPhase } from "@/components/MoonPhase";
import { getCurrentPosition } from "@tauri-apps/plugin-geolocation";

interface AppInfo {
  name: string;
  version: string;
  description: string;
}

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

  // New/Edit location dialog
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [locationForm, setLocationForm] = useState({
    name: "",
    latitude: "",
    longitude: "",
    horizonText: "",
  });

  // Plate solving settings
  const [plateSolveSolver, setPlateSolveSolver] = useState(() =>
    localStorage.getItem("plate_solve_solver") || "nova"
  );
  const [astrometryApiKey, setAstrometryApiKey] = useState(() =>
    localStorage.getItem("astrometry_api_key") || ""
  );

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
    });
    setLocationDialogOpen(true);
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
      });
      toast.success("Location updated");
    } else {
      addLocation({
        name: locationForm.name,
        latitude: lat,
        longitude: lng,
        horizon,
      });
      toast.success("Location added");
    }

    setLocationDialogOpen(false);
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
                    <div className="mb-3">
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
              <div className="space-y-2">
                <Label htmlFor="api-key">Astrometry.net API Key</Label>
                <div className="flex gap-2">
                  <Input
                    id="api-key"
                    type="password"
                    value={astrometryApiKey}
                    onChange={(e) => setAstrometryApiKey(e.target.value)}
                    placeholder="Enter your API key"
                  />
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
    </div>
  );
}
