/**
 * Admin/Settings Page
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
} from "lucide-react";
import { appApi, backupApi, type BackupInfo } from "@/lib/tauri/commands";
import { MoonPhase } from "@/components/MoonPhase";

interface AppInfo {
  name: string;
  version: string;
  description: string;
}

export default function AdminPage() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationName, setLocationName] = useState("");
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);

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

    // Try to load saved location from localStorage
    const saved = localStorage.getItem("observer_location");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setLocation(parsed);
        setLocationName(parsed.name || "");
      } catch {
        // Ignore parse errors
      }
    }
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

  // Get current location
  const getCurrentLocation = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not supported");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const loc = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        setLocation(loc);
        localStorage.setItem(
          "observer_location",
          JSON.stringify({ ...loc, name: locationName })
        );
        toast.success("Location updated");
      },
      (error) => {
        toast.error(`Location error: ${error.message}`);
      }
    );
  };

  // Save location name
  const saveLocationName = () => {
    if (location) {
      localStorage.setItem(
        "observer_location",
        JSON.stringify({ ...location, name: locationName })
      );
      toast.success("Location name saved");
    }
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

        {/* Observer Location */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              Observer Location
            </CardTitle>
            <CardDescription>
              Set your observing location for accurate altitude calculations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Location Name</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="e.g., Backyard Observatory"
                />
                <Button variant="outline" onClick={saveLocationName} disabled={!location}>
                  Save
                </Button>
              </div>
            </div>

            {location ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Latitude</Label>
                  <p className="font-mono">{location.latitude.toFixed(4)}°</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Longitude</Label>
                  <p className="font-mono">{location.longitude.toFixed(4)}°</p>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">No location set</p>
            )}

            <Button onClick={getCurrentLocation} className="w-full">
              <MapPin className="w-4 h-4 mr-2" />
              Get Current Location
            </Button>
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
          latitude={location?.latitude}
          longitude={location?.longitude}
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
