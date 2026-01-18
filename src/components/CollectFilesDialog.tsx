/**
 * Collect Files Dialog - Collects raw subframe files for a target
 */

import { useState, useEffect } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderOpen, Loader2, X } from "lucide-react";
import { collectApi } from "@/lib/tauri/commands";
import { toast } from "sonner";

interface CollectFilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetName: string;
  stackedPaths: string[];
}

interface CollectProgress {
  current: number;
  total: number;
  current_file: string;
  percent: number;
  cancelled: boolean;
  phase: string;
}

export default function CollectFilesDialog({
  open,
  onOpenChange,
  targetName,
  stackedPaths,
}: CollectFilesDialogProps) {
  const [targetDirectory, setTargetDirectory] = useState("");
  const [isCollecting, setIsCollecting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState<CollectProgress | null>(null);
  const [result, setResult] = useState<{
    files_copied: number;
    files_skipped: number;
    bytes_copied: number;
    errors: string[];
  } | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setTargetDirectory("");
      setProgress(null);
      setResult(null);
      setIsCollecting(false);
      setIsCancelling(false);
    }
  }, [open]);

  const handleSelectDirectory = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Target Directory for Raw Files",
      });
      if (selected && typeof selected === "string") {
        setTargetDirectory(selected);
        setResult(null);
      }
    } catch (error) {
      console.error("Failed to open directory picker:", error);
    }
  };

  const handleCollect = async () => {
    if (!targetDirectory || stackedPaths.length === 0) return;

    setIsCollecting(true);
    setProgress(null);
    setResult(null);

    // Set up progress event listener
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<CollectProgress>("collect-progress", (event) => {
        setProgress(event.payload);
      });
    } catch (err) {
      console.error("Failed to set up progress listener:", err);
    }

    try {
      const collectResult = await collectApi.collect({
        stacked_paths: stackedPaths,
        target_directory: targetDirectory,
      });

      setResult(collectResult);

      if (collectResult.files_copied > 0) {
        const mbCopied = (collectResult.bytes_copied / 1_000_000).toFixed(1);
        toast.success(
          `Copied ${collectResult.files_copied} files (${mbCopied} MB)`
        );
      } else if (collectResult.files_skipped > 0) {
        toast.info("No new files to copy - all files already exist");
      } else {
        toast.warning("No subframe files found for this target");
      }

      if (collectResult.errors.length > 0) {
        console.error("Collect errors:", collectResult.errors);
      }
    } catch (error) {
      console.error("Collect failed:", error);
      toast.error(`Failed to collect files: ${error}`);
    } finally {
      setIsCollecting(false);
      setIsCancelling(false);
      if (unlisten) {
        unlisten();
      }
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    try {
      await collectApi.cancel();
    } catch (error) {
      console.error("Failed to cancel:", error);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dark max-w-lg bg-slate-900 border-slate-700">
        <DialogHeader>
          <DialogTitle className="text-white">Collect Raw Files</DialogTitle>
          <DialogDescription className="text-slate-400">
            Collect raw subframe files for <strong className="text-white">{targetName}</strong> from
            Seestar _sub directories.
          </DialogDescription>
        </DialogHeader>

        {/* Collecting Overlay */}
        {isCollecting && (
          <div className="absolute inset-0 bg-slate-900/95 z-10 flex items-center justify-center rounded-lg">
            <div className="p-6 max-w-sm w-full space-y-4">
              <h3 className="text-lg font-semibold text-white text-center">
                {isCancelling ? "Cancelling..." : "Collecting Files..."}
              </h3>

              {/* Progress bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-slate-400">
                  <span>
                    {progress
                      ? progress.total > 0
                        ? `${progress.current} of ${progress.total}`
                        : "Scanning..."
                      : "Starting..."}
                  </span>
                  <span>
                    {progress && progress.total > 0 ? `${progress.percent}%` : ""}
                  </span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2.5 overflow-hidden">
                  {progress && progress.phase === "scanning" ? (
                    <div className="h-full w-1/3 bg-teal-500 rounded-full animate-pulse" />
                  ) : (
                    <div
                      className={`h-full rounded-full transition-all duration-300 ease-out ${
                        isCancelling ? "bg-yellow-500" : "bg-teal-500"
                      }`}
                      style={{ width: `${progress?.percent ?? 0}%` }}
                    />
                  )}
                </div>
              </div>

              {/* Current file */}
              {progress && (
                <p className="text-slate-400 text-sm text-center truncate">
                  {progress.current_file}
                </p>
              )}

              {/* Cancel button */}
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  disabled={isCancelling}
                  className="border-slate-600 text-slate-300 hover:bg-slate-700"
                >
                  {isCancelling ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    <>
                      <X className="w-4 h-4 mr-2" />
                      Cancel
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* Source info */}
          <div className="space-y-2">
            <Label className="text-slate-300">Source Images</Label>
            <p className="text-sm text-slate-400">
              {stackedPaths.length} stacked image{stackedPaths.length !== 1 ? "s" : ""} selected.
              Will search for Light_*.fit files in corresponding _sub directories.
            </p>
          </div>

          {/* Target directory selection */}
          <div className="space-y-2">
            <Label className="text-slate-300">Target Directory</Label>
            <div className="flex gap-2">
              <Input
                value={targetDirectory}
                onChange={(e) => setTargetDirectory(e.target.value)}
                placeholder="Select target directory..."
                className="flex-1 bg-slate-800 border-slate-600 text-white placeholder:text-slate-500"
                readOnly
              />
              <Button
                variant="outline"
                size="icon"
                onClick={handleSelectDirectory}
                className="border-slate-600 text-slate-300 hover:bg-slate-700"
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Results */}
          {result && (
            <div className="bg-slate-800 rounded-lg p-4 space-y-2">
              <h4 className="font-medium text-white">Results</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-slate-400">Files copied:</span>
                <span className="text-white">{result.files_copied}</span>
                <span className="text-slate-400">Files skipped:</span>
                <span className="text-white">{result.files_skipped}</span>
                <span className="text-slate-400">Total size:</span>
                <span className="text-white">{formatBytes(result.bytes_copied)}</span>
              </div>
              {result.errors.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-700">
                  <p className="text-red-400 text-sm">
                    {result.errors.length} error{result.errors.length !== 1 ? "s" : ""} occurred
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={handleCollect}
              disabled={!targetDirectory || isCollecting}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {isCollecting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Collecting...
                </>
              ) : (
                "Collect Files"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
