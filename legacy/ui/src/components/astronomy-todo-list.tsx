"use client";

import {useEffect, useState} from "react"
import {toast} from "sonner"
import {Tabs, TabsList, TabsTrigger} from "@/components/ui/tabs"
import {ObjectAltitudeDialog} from "@/components/object-altitude-dialog"
import {
  azimuthToCompassDirection,
  calculateCurrentAltitude,
  calculateCurrentAzimuth,
  compareAstronomicalTimes,
  defaultCoordinates,
  formatTime,
  generateNightAltitudeData,
  getMaxAltitudeTime,
  parseCoordinates,
} from "@/lib/astronomy-utils"
import {EditNotesDialog} from "@/components/edit-notes-dialog"
import {AstronomyObject, SortDirection, SortField} from "@/components/todo-list-types"
import {AddObjectDialog} from "@/components/add-object-dialog"
import {GoalTimeDialog} from "@/components/goal-time-dialog"
import {ObjectListHeader} from "@/components/object-list-header"
import {ObjectListItem} from "@/components/object-list-item"
import {TypeFilter} from "@/components/type-filter"
import {EmptyState} from "@/components/empty-state"
import {SyncStatus} from "@/components/sync-status"
import {DataManagementDropdown} from "@/components/data-management-dropdown"
import {ImportDialog} from "@/components/import-dialog"
import {useDataSync} from "@/components/use-data-sync"
import {useAuth} from "@/hooks/useAuth"

// Safe localStorage helper for SSR
const safeGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

// Main Component
export function AstronomyTodoList() {
  const { effectiveUserId, effectiveIsSignedIn, effectiveIsLoaded } = useAuth();
  const [objectName, setObjectName] = useState("");
  const [notes, setNotes] = useState("");
  const [isLookupLoading, setIsLookupLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [selectedObject, setSelectedObject] = useState<AstronomyObject | null>(null);
  const [altitudeDialogOpen, setAltitudeDialogOpen] = useState(false);
  const [coordinates, setCoordinates] = useState(defaultCoordinates);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [goalTimeDialogOpen, setGoalTimeDialogOpen] = useState(false);
  const [goalTimeObject, setGoalTimeObject] = useState<AstronomyObject | null>(null);
  const [newGoalTime, setNewGoalTime] = useState<string>("");
  const [maxAltitudeCache, setMaxAltitudeCache] = useState<Record<string, string>>({});
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [editingObject, setEditingObject] = useState<AstronomyObject | null>(null);
  const [editNotes, setEditNotes] = useState("");
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // Initialize with empty array, will load from localStorage first
  const {
    objects,
    setObjects,
    isLoading,
    isSyncing,
    lastSyncTime,
    fetchData,
    syncData,
    addObject,
    updateObject,
    deleteObject,
    importObjects
  } = useDataSync(effectiveUserId!, []);

  // Load data from localStorage and then from API when component mounts
  useEffect(() => {
    // First try to load from localStorage for immediate display
    const savedObjects = safeGetItem("astronomyTodoObjects");
    if (savedObjects) {
      setObjects(JSON.parse(savedObjects));
    }

    // Try to load user coordinates
    const savedCoordinates = safeGetItem("userAstronomyCoordinates");
    if (savedCoordinates) {
      setCoordinates(JSON.parse(savedCoordinates));
    }

    // Fetch from API if user is authenticated (including SQLite mode)
    if (effectiveIsLoaded && effectiveIsSignedIn && effectiveUserId) {
      fetchData();
    }

    setInitialLoadComplete(true);
  }, [effectiveIsLoaded, effectiveIsSignedIn, effectiveUserId, fetchData, setObjects]);

  // Extract available object types for filtering
  useEffect(() => {
    const types = objects
      .map(obj => obj.objectType || "Unknown")
      .filter((type, index, self) => self.indexOf(type) === index)
      .sort();
    setAvailableTypes(types);
  }, [objects]);

  // Calculate max altitude times for all objects
  useEffect(() => {
    const calculateMaxAltitudeTimes = async () => {
      // First, check if we need to update the cache
      let needsUpdate = false;

      // Check if any objects don't have a cached value
      for (const obj of objects) {
        if (!maxAltitudeCache[obj.id]) {
          needsUpdate = true;
          break;
        }
      }

      if (!needsUpdate) return;

      // Create a new cache to avoid state update issues
      const newCache = { ...maxAltitudeCache };

      // Calculate for each object
      for (const obj of objects) {
        // Skip if already calculated
        if (newCache[obj.id]) continue;

        const parsedCoords = parseCoordinates(obj.ra, obj.dec);
        if (parsedCoords) {
          const { raDeg, decDeg } = parsedCoords;
          const altitudeData = generateNightAltitudeData(raDeg, decDeg, coordinates);
          const maxTime = getMaxAltitudeTime(altitudeData);
          if (maxTime) {
            newCache[obj.id] = formatTime(maxTime);
          }
        }
      }

      // Update the cache
      setMaxAltitudeCache(newCache);
    };

    calculateMaxAltitudeTimes();
  }, [objects, coordinates, maxAltitudeCache]);

  const handleLookupObject = async () => {
    if (!objectName.trim()) {
      toast.error("Please enter an object name");
      return;
    }

    setIsLookupLoading(true);

    try {
      // Fetch data from Simbad via a server action or API route
      const response = await fetch(`/api/lookup-astronomy-object?name=${encodeURIComponent(objectName)}`);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to find object");
      }

      const data = await response.json();

      if (!data) {
        throw new Error("Object not found");
      }

      let name = data.name;
      if (name.startsWith("NAME ")) {
        name = name.replace("NAME ", "");
      }

      // Create new object
      const newObject: AstronomyObject = {
        id: crypto.randomUUID(),
        name,
        ra: data.ra || "N/A",
        dec: data.dec || "N/A",
        magnitude: data.magnitude || "N/A",
        size: data.size || "N/A",
        objectType: data.objectType || "Unknown",
        addedAt: new Date().toISOString(),
        completed: false,
        notes: notes.trim() || undefined,
      };

      // Add to database/state with the sync hook
      await addObject(newObject);

      setObjectName("");
      setNotes("");
      setDialogOpen(false);
      toast.success(`Added ${data.name} to your todo list`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Error looking up object. Please check the name and try again.");
      console.error(error);
    } finally {
      setIsLookupLoading(false);
    }
  };

  const handleRemoveObject = async (id: string) => {
    const objectToRemove = objects.find(obj => obj.id === id);
    if (!objectToRemove) return;

    await deleteObject(id);
    toast.success(`Removed ${objectToRemove.name} from your todo list`);
  };

  const handleToggleCompletion = async (id: string) => {
    const objectToUpdate = objects.find(obj => obj.id === id);
    if (!objectToUpdate) return;

    const completed = !objectToUpdate.completed;
    const updatedObject = {
      ...objectToUpdate,
      completed,
      completedAt: completed ? new Date().toISOString() : undefined
    };

    await updateObject(updatedObject);

    const action = completed ? "completed" : "marked as incomplete";
    toast.success(`${objectToUpdate.name} ${action}`);
  };

  // Add this new handler to the existing component
  // Add this right after handleToggleCompletion method
  const handleToggleFlag = async (id: string) => {
    const objectToUpdate = objects.find(obj => obj.id === id);
    if (!objectToUpdate) return;

    const flagged = !objectToUpdate.flagged;
    const updatedObject = {
      ...objectToUpdate,
      flagged
    };

    await updateObject(updatedObject);

    const action = flagged ? "flagged" : "unflagged";
    toast.success(`${objectToUpdate.name} ${action}`);
  };

  const handleShowAltitude = (object: AstronomyObject) => {
    setSelectedObject(object);
    setAltitudeDialogOpen(true);
  };

  const handleSetGoalTime = (object: AstronomyObject) => {
    setGoalTimeObject(object);
    setNewGoalTime(object.goalTime || "");
    setGoalTimeDialogOpen(true);
  };

  const saveGoalTime = async () => {
    if (!goalTimeObject) return;

    const updatedObject = {
      ...goalTimeObject,
      goalTime: newGoalTime || undefined
    };

    await updateObject(updatedObject);
    setGoalTimeDialogOpen(false);
    toast.success(`Goal time set for ${goalTimeObject.name}`);
  };

  const handleEditNotes = (object: AstronomyObject) => {
    setEditingObject(object);
    setEditNotes(object.notes || "");
    setNotesDialogOpen(true);
  };

  const saveNotes = async () => {
    if (!editingObject) return;

    const updatedObject = {
      ...editingObject,
      notes: editNotes.trim() || undefined
    };

    await updateObject(updatedObject);
    setNotesDialogOpen(false);
    toast.success(`Notes updated for ${editingObject.name}`);
  };

  // Apply goal time from altitude dialog
  const handleSetGoalTimeFromAltitude = async (time: string) => {
    if (!selectedObject) return;

    const updatedObject = {
      ...selectedObject,
      goalTime: time
    };

    await updateObject(updatedObject);
  };

  // Function to handle Enter key press in the input field
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isLookupLoading) {
      handleLookupObject();
    }
  };

  // Calculate current altitude for display in the table
  const getCurrentAltitude = (ra: string, dec: string): number | null => {
    const coords = parseCoordinates(ra, dec);
    if (!coords) return null;

    return calculateCurrentAltitude(coords.raDeg, coords.decDeg, coordinates);
  };

  // Add this new function after getCurrentAltitude
  const getCurrentAzimuth = (ra: string, dec: string): { degrees: number | null; direction: string | null } => {
    const coords = parseCoordinates(ra, dec);
    if (!coords) return { degrees: null, direction: null };

    const azimuthDegrees = calculateCurrentAzimuth(coords.raDeg, coords.decDeg, coordinates);
    const compassDirection = azimuthToCompassDirection(azimuthDegrees);

    return {
      degrees: azimuthDegrees,
      direction: compassDirection
    };
  };

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cycle through: asc -> desc -> null (unsorted)
      if (sortDirection === "asc") {
        setSortDirection("desc");
      } else if (sortDirection === "desc") {
        setSortDirection(null);
        setSortField(null);
      } else {
        setSortDirection("asc");
      }
    } else {
      // Set new field and default to ascending
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Handle type filter changes
  const handleTypeFilterChange = (type: string) => {
    setSelectedTypes(prev => {
      if (prev.includes(type)) {
        return prev.filter(t => t !== type);
      } else {
        return [...prev, type];
      }
    });
  };

  // Handle manual sync
  const handleManualSync = () => {
    syncData(objects);
  };

  // Handle export functionality
  const handleExport = (format: 'json' | 'csv') => {
    if (objects.length === 0) {
      toast.error("No objects to export");
      return;
    }

    try {
      let data: string;
      let filename: string;
      let mimeType: string;

      if (format === 'json') {
        // Export as JSON
        data = JSON.stringify(objects, null, 2);
        filename = `astronomy-todo-list-${new Date().toISOString().split('T')[0]}.json`;
        mimeType = 'application/json';
      } else {
        // Export as CSV
        // Create CSV header row
        const headers = [
          'Name',
          'Type',
          'RA',
          'Dec',
          'Magnitude',
          'Size',
          'Current Altitude',
          'Current Direction',
          'Added Date',
          'Completed',
          'Completion Date',
          'Goal Time',
          'Notes'
        ].join(',');

        // Create CSV data rows
        const rows = objects.map(obj => {
          const altitude = getCurrentAltitude(obj.ra, obj.dec);
          const azimuth = getCurrentAzimuth(obj.ra, obj.dec);

          // Wrap string values in quotes, especially notes which may contain commas
          return [
            `"${obj.name}"`,
            `"${obj.objectType || 'Unknown'}"`,
            `"${obj.ra}"`,
            `"${obj.dec}"`,
            obj.magnitude,
            obj.size,
            altitude !== null ? altitude.toFixed(1) : 'N/A',
            azimuth.direction || 'N/A',
            obj.addedAt ? new Date(obj.addedAt).toLocaleDateString() : '',
            obj.completed ? 'Yes' : 'No',
            obj.completedAt ? new Date(obj.completedAt).toLocaleDateString() : '',
            obj.goalTime || '',
            obj.notes ? `"${obj.notes.replace(/"/g, '""')}"` : '' // Escape quotes in notes
          ].join(',');
        }).join('\n');

        data = `${headers}\n${rows}`;
        filename = `astronomy-todo-list-${new Date().toISOString().split('T')[0]}.csv`;
        mimeType = 'text/csv';
      }

      // Create a blob and download link
      const blob = new Blob([data], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      // Set up download
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.display = 'none';

      // Append to document, trigger download, and clean up
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`Exported observation list as ${format.toUpperCase()}`);
    } catch (error) {
      console.error('Error exporting data:', error);
      toast.error('Failed to export data');
    }
  };

  // Handle import
  const handleImport = async (importedObjects: AstronomyObject[], importMode: "replace" | "merge") => {
    try {
      await importObjects(importedObjects, importMode);

      const action = importMode === "replace" ? "replaced" : "merged with";
      toast.success(`Successfully ${action} your observation list (${importedObjects.length} objects)`);
    } catch (error) {
      console.error('Error importing data:', error);
      toast.error('Failed to import data');
    }
  };

  // Apply filters and sorting
  const filteredAndSortedObjects = (() => {
    // First, filter by tab (completion status)
    let result = objects.filter(obj => {
      if (activeTab === "all") return true;
      if (activeTab === "pending") return !obj.completed;
      if (activeTab === "flagged") return obj.flagged;
      if (activeTab === "completed") return obj.completed;
      return true;
    });

    // Then filter by object type
    if (selectedTypes.length > 0) {
      result = result.filter(obj =>
        selectedTypes.includes(obj.objectType || "Unknown")
      );
    }

    // Then sort if a sort field is active
    if (sortField && sortDirection) {
      result = [...result].sort((a, b) => {
        let compareResult: number;

        switch (sortField) {
          case "name":
            compareResult = a.name.localeCompare(b.name);
            break;
          case "magnitude": {
            const magA = parseFloat(a.magnitude);
            const magB = parseFloat(b.magnitude);
            // Lower magnitude is brighter (better)
            if (isNaN(magA) && isNaN(magB)) compareResult = 0;
            else if (isNaN(magA)) compareResult = 1;
            else if (isNaN(magB)) compareResult = -1;
            else compareResult = magA - magB;
            break;
          }
          case "size": {
            const sizeA = parseFloat(a.size);
            const sizeB = parseFloat(b.size);
            // Larger size is better
            if (isNaN(sizeA) && isNaN(sizeB)) compareResult = 0;
            else if (isNaN(sizeA)) compareResult = 1;
            else if (isNaN(sizeB)) compareResult = -1;
            else compareResult = sizeA - sizeB;
            break;
          }
          case "altitude": {
            const altA = getCurrentAltitude(a.ra, a.dec) || -100;
            const altB = getCurrentAltitude(b.ra, b.dec) || -100;
            compareResult = altA - altB;
            break;
          }
          case "goalTime":
            // Handle empty times for goal time sorting
            if (!a.goalTime && !b.goalTime) compareResult = 0;
            else if (!a.goalTime) compareResult = 1;  // Empty times always last
            else if (!b.goalTime) compareResult = -1;
            else compareResult = compareAstronomicalTimes(a.goalTime, b.goalTime);
            break;
          case "maxTime":
            // Handle empty times for max altitude time sorting
            if (!maxAltitudeCache[a.id] && !maxAltitudeCache[b.id]) compareResult = 0;
            else if (!maxAltitudeCache[a.id]) compareResult = 1;  // Empty times always last
            else if (!maxAltitudeCache[b.id]) compareResult = -1;
            else compareResult = compareAstronomicalTimes(
              maxAltitudeCache[a.id],
              maxAltitudeCache[b.id]
            );
            break;
          case "azimuth": {
            const azimuthA = getCurrentAzimuth(a.ra, a.dec).degrees || 999;
            const azimuthB = getCurrentAzimuth(b.ra, b.dec).degrees || 999;
            compareResult = azimuthA - azimuthB;
            break;
          }
          default:
            compareResult = 0;
        }

        // For descending order, reverse the comparison but keep empty values at the end
        if (sortDirection === "desc") {
          // Special case for times: we want to keep empty values at the end
          if ((sortField === "goalTime" || sortField === "maxTime") &&
            ((!a.goalTime && sortField === "goalTime") || (!maxAltitudeCache[a.id] && sortField === "maxTime") ||
              (!b.goalTime && sortField === "goalTime") || (!maxAltitudeCache[b.id] && sortField === "maxTime"))) {
            // Keep the empty values at the end
            return compareResult;
          }
          return -compareResult;
        }

        return compareResult;
      });
    }

    return result;
  })();

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h4 className="text-xl font-medium">Your Observation Todo List</h4>
        <div className="flex items-center space-x-4">
          <SyncStatus
            lastSyncTime={lastSyncTime}
            isSyncing={isSyncing}
            onSync={handleManualSync}
            isAuthenticated={!!effectiveUserId}
          />
          <DataManagementDropdown
            objects={objects}
            onExport={handleExport}
            onImportClick={() => setImportDialogOpen(true)}
          />
          <AddObjectDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            objectName={objectName}
            setObjectName={setObjectName}
            notes={notes}
            setNotes={setNotes}
            onAddObject={handleLookupObject}
            isLoading={isLookupLoading}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>

      <div className="flex justify-between items-center">
        <Tabs defaultValue="all" value={activeTab} onValueChange={setActiveTab} className="w-auto">
          <TabsList className="grid grid-cols-4">
            <TabsTrigger value="all">All Objects ({objects.length})</TabsTrigger>
            <TabsTrigger value="pending">Pending ({objects.filter(obj => !obj.completed).length})</TabsTrigger>
            <TabsTrigger value="flagged">Flagged ({objects.filter(obj => obj.flagged).length})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({objects.filter(obj => obj.completed).length})</TabsTrigger>
          </TabsList>
        </Tabs>

        {availableTypes.length > 0 && (
          <TypeFilter
            availableTypes={availableTypes}
            selectedTypes={selectedTypes}
            onTypeFilterChange={handleTypeFilterChange}
            onClearFilters={() => setSelectedTypes([])}
          />
        )}
      </div>

      {isLoading && !initialLoadComplete ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">Loading your observation list...</p>
        </div>
      ) : filteredAndSortedObjects.length === 0 ? (
        <EmptyState
          activeTab={activeTab}
          hasFilters={selectedTypes.length > 0}
        />
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <ObjectListHeader
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
          />
          <div className="max-h-[600px] overflow-y-auto">
            {filteredAndSortedObjects.map((obj) => (
              <ObjectListItem
                key={obj.id}
                object={obj}
                currentAltitude={getCurrentAltitude(obj.ra, obj.dec)}
                currentAzimuth={getCurrentAzimuth(obj.ra, obj.dec)}
                maxAltitudeCache={maxAltitudeCache}
                onToggleCompletion={handleToggleCompletion}
                onSetGoalTime={handleSetGoalTime}
                onEditNotes={handleEditNotes}
                onShowAltitude={handleShowAltitude}
                onRemove={handleRemoveObject}
                onToggleFlag={handleToggleFlag}
              />
            ))}
          </div>
        </div>
      )}

      {selectedObject && (
        <ObjectAltitudeDialog
          open={altitudeDialogOpen}
          onOpenChange={setAltitudeDialogOpen}
          objectName={selectedObject.name}
          ra={selectedObject.ra}
          dec={selectedObject.dec}
          onSetGoalTime={handleSetGoalTimeFromAltitude}
        />
      )}

      {/* Goal Time Dialog */}
      <GoalTimeDialog
        open={goalTimeDialogOpen}
        onOpenChange={setGoalTimeDialogOpen}
        object={goalTimeObject}
        goalTime={newGoalTime}
        setGoalTime={setNewGoalTime}
        onSave={saveGoalTime}
        maxAltitudeCache={maxAltitudeCache}
      />

      {/* Notes Dialog */}
      <EditNotesDialog
        open={notesDialogOpen}
        onOpenChange={setNotesDialogOpen}
        object={editingObject}
        notes={editNotes}
        setNotes={setEditNotes}
        onSave={saveNotes}
      />

      {/* Import Dialog */}
      <ImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImport={handleImport}
      />
    </div>
  );
}
