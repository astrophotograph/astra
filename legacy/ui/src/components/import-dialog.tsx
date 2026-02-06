"use client";

import {useEffect, useRef, useState} from "react"
import {Button} from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {Tabs, TabsContent, TabsList, TabsTrigger} from "@/components/ui/tabs"
import {Label} from "@/components/ui/label"
import {Textarea} from "@/components/ui/textarea"
import {AstronomyObject} from "@/components/todo-list-types"

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (data: AstronomyObject[], importMode: "replace" | "merge") => void;
}

export function ImportDialog({ open, onOpenChange, onImport }: ImportDialogProps) {
  const [importTab, setImportTab] = useState<string>("file");
  const [jsonData, setJsonData] = useState<string>("");
  const [csvData, setCSVData] = useState<string>("");
  const [importMode, setImportMode] = useState<"replace" | "merge">("merge");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [fileSelected, setFileSelected] = useState<boolean>(false);
  const [fileType, setFileType] = useState<"json" | "csv" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setJsonData("");
    setCSVData("");
    setImportTab("file");
    setValidationError(null);
    setImportMode("merge");
    setIsProcessing(false);
    setFileSelected(false);
    setFileType(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // Handle dialog close
  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open]);

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValidationError(null);
    const file = e.target.files?.[0];

    if (!file) {
      setFileSelected(false);
      setFileType(null);
      return;
    }

    // Check file size (limit to 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setValidationError("File is too large. Maximum size is 5MB.");
      setFileSelected(false);
      return;
    }

    // Determine file type based on extension
    if (file.name.endsWith('.json')) {
      setFileType("json");
      setFileSelected(true);
    } else if (file.name.endsWith('.csv')) {
      setFileType("csv");
      setFileSelected(true);
    } else {
      setValidationError("Unsupported file type. Please upload a JSON or CSV file.");
      setFileSelected(false);
      setFileType(null);
    }
  };

  // Process and validate the import data
  const processImport = async () => {
    setIsProcessing(true);
    setValidationError(null);

    try {
      let importedObjects: AstronomyObject[] = [];

      // If using file upload, read the file first
      if (importTab === "file" && fileSelected && fileInputRef.current?.files?.[0]) {
        const file = fileInputRef.current.files[0];
        const content = await readFileAsText(file);

        if (fileType === "json") {
          importedObjects = parseJsonData(content);
        } else if (fileType === "csv") {
          importedObjects = parseCsvData(content);
        }
      } else if (importTab === "json") {
        // Process JSON input from textarea
        importedObjects = parseJsonData(jsonData);
      } else if (importTab === "csv") {
        // Process CSV input from textarea
        importedObjects = parseCsvData(csvData);
      } else {
        throw new Error("Please select a file or enter data to import");
      }

      if (importedObjects.length === 0) {
        throw new Error("No valid objects found in the import data");
      }

      // Pass data to parent component
      onImport(importedObjects, importMode);
      onOpenChange(false);
    } catch (error) {
      console.error('Import error:', error);
      setValidationError(error instanceof Error ? error.message : "Failed to process import data");
    } finally {
      setIsProcessing(false);
    }
  };

  // Helper function to read file as text
  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        resolve(event.target?.result as string || "");
      };
      reader.onerror = () => {
        reject(new Error("Error reading file"));
      };
      reader.readAsText(file);
    });
  };

  // Parse JSON data
  const parseJsonData = (data: string): AstronomyObject[] => {
    if (!data.trim()) {
      throw new Error("No JSON data provided");
    }

    const parsedData = JSON.parse(data);

    if (!Array.isArray(parsedData)) {
      throw new Error("Invalid JSON format. Expected an array of objects.");
    }

    // Validate that the data has the expected fields
    return parsedData.map((item, index) => {
      if (!item.name || !item.ra || !item.dec) {
        throw new Error(`Item at index ${index} is missing required fields (name, RA, Dec)`);
      }

      // Ensure proper format and assign new IDs to prevent conflicts
      return {
        id: item.id || crypto.randomUUID(),
        name: item.name,
        ra: item.ra,
        dec: item.dec,
        magnitude: item.magnitude || "N/A",
        size: item.size || "N/A",
        objectType: item.objectType || "Unknown",
        addedAt: item.addedAt || new Date().toISOString(),
        completed: Boolean(item.completed),
        completedAt: item.completedAt,
        goalTime: item.goalTime,
        notes: item.notes
      };
    });
  };

  // Parse CSV data
  const parseCsvData = (data: string): AstronomyObject[] => {
    if (!data.trim()) {
      throw new Error("No CSV data provided");
    }

    // Split CSV into lines
    const lines = data.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      throw new Error("CSV must contain a header row and at least one data row");
    }

    // Parse header row
    const headers = parseCSVLine(lines[0]);

    // Required column indexes
    const nameIndex = headers.findIndex(h => h.toLowerCase() === 'name');
    const raIndex = headers.findIndex(h => h.toLowerCase() === 'ra');
    const decIndex = headers.findIndex(h => h.toLowerCase() === 'dec');

    if (nameIndex === -1 || raIndex === -1 || decIndex === -1) {
      throw new Error("CSV must contain Name, RA, and Dec columns");
    }

    // Map other column indexes
    const typeIndex = headers.findIndex(h => h.toLowerCase() === 'type');
    const magnitudeIndex = headers.findIndex(h => h.toLowerCase() === 'magnitude');
    const sizeIndex = headers.findIndex(h => h.toLowerCase() === 'size');
    const addedDateIndex = headers.findIndex(h => h.toLowerCase().includes('added date'));
    const completedIndex = headers.findIndex(h => h.toLowerCase() === 'completed');
    const completionDateIndex = headers.findIndex(h => h.toLowerCase().includes('completion date'));
    const goalTimeIndex = headers.findIndex(h => h.toLowerCase().includes('goal time'));
    const notesIndex = headers.findIndex(h => h.toLowerCase() === 'notes');

    // Process data rows
    const importedObjects: AstronomyObject[] = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      const values = parseCSVLine(lines[i]);

      if (values.length < 3) continue; // Skip rows with insufficient data

      const name = values[nameIndex]?.trim();
      const ra = values[raIndex]?.trim();
      const dec = values[decIndex]?.trim();

      if (!name || !ra || !dec) continue;

      importedObjects.push({
        id: crypto.randomUUID(), // Generate new ID for imported items
        name: name,
        ra: ra,
        dec: dec,
        magnitude: magnitudeIndex >= 0 ? values[magnitudeIndex]?.trim() || "N/A" : "N/A",
        size: sizeIndex >= 0 ? values[sizeIndex]?.trim() || "N/A" : "N/A",
        objectType: typeIndex >= 0 ? values[typeIndex]?.trim() || "Unknown" : "Unknown",
        addedAt: addedDateIndex >= 0 && values[addedDateIndex]?.trim()
          ? new Date(values[addedDateIndex]).toISOString()
          : new Date().toISOString(),
        completed: completedIndex >= 0
          ? values[completedIndex]?.trim().toLowerCase() === 'yes'
          : false,
        completedAt: completionDateIndex >= 0 && values[completionDateIndex]?.trim()
          ? new Date(values[completionDateIndex]).toISOString()
          : undefined,
        goalTime: goalTimeIndex >= 0 ? values[goalTimeIndex]?.trim() || undefined : undefined,
        notes: notesIndex >= 0 ? values[notesIndex]?.trim() || undefined : undefined
      });
    }

    return importedObjects;
  };

  // Helper function to parse CSV lines handling quoted values
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && i+1 < line.length && line[i+1] === '"') {
          // Double quotes inside quoted string - add single quote
          current += '"';
          i++; // Skip the next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    // Add the last field
    result.push(current);

    return result;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle>Import Observation List</DialogTitle>
          <DialogDescription>
            Import your astronomy objects from a JSON or CSV file
          </DialogDescription>
        </DialogHeader>

        <Tabs value={importTab} onValueChange={setImportTab}>
          <TabsList className="grid grid-cols-3">
            <TabsTrigger value="file">Upload File</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
            <TabsTrigger value="csv">CSV</TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="space-y-4 pt-4">
            <div className="grid w-full max-w-sm items-center gap-1.5">
              <Label htmlFor="todolist-file">Upload a JSON or CSV file</Label>
              <input
                id="todolist-file"
                type="file"
                accept=".json,.csv"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20"
              />
              {fileSelected && (
                <div className="text-sm text-green-500 mt-1">
                  File selected: {fileType?.toUpperCase()} format
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="json" className="space-y-4 pt-4">
            <div className="grid w-full gap-1.5">
              <Label htmlFor="json-input">Paste JSON data</Label>
              <Textarea
                id="json-input"
                placeholder='[{"id":"1","name":"M31","ra":"00h 42m 44.3s","dec":"+41° 16 09\"","magnitude":"3.4","size":"178.0","objectType":"Galaxy"}]'
                value={jsonData}
                onChange={(e) => setJsonData(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
              />
            </div>
          </TabsContent>

          <TabsContent value="csv" className="space-y-4 pt-4">
            <div className="grid w-full gap-1.5">
              <Label htmlFor="csv-input">Paste CSV data</Label>
              <Textarea
                id="csv-input"
                placeholder='Name,Type,RA,Dec,Magnitude,Size M31,Galaxy,00h 42m 44.3s,+41° 16 09",3.4,178.0'
                value={csvData}
                onChange={(e) => setCSVData(e.target.value)}
                className="min-h-[200px] font-mono text-sm"
              />
            </div>
          </TabsContent>
        </Tabs>

        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Label>Import Mode:</Label>
            <select
              value={importMode}
              onChange={(e) => setImportMode(e.target.value as "replace" | "merge")}
              className="p-2 rounded-md border border-input bg-background"
            >
              <option value="merge">Merge with existing list</option>
              <option value="replace">Replace existing list</option>
            </select>
          </div>

          {validationError && (
            <div className="text-sm text-destructive">{validationError}</div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            onClick={processImport}
            disabled={isProcessing || (importTab === "file" ? !fileSelected : importTab === "json" ? !jsonData : !csvData)}
          >
            {isProcessing ? "Processing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
