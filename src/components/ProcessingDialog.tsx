/**
 * Processing Dialog - Configure and run image processing
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import {
  imageProcessApi,
  TARGET_TYPES,
  STRETCH_METHODS,
  type ProcessImageInput,
  type ProcessImageResponse,
  type TargetInfo,
} from "@/lib/tauri/commands";

/** Progress event payload from backend */
interface ProcessingProgressEvent {
  imageId: string;
  step: string;
  progress: number;
  message: string;
}

/** Human-readable step names */
const STEP_LABELS: Record<string, string> = {
  init: "Initializing",
  loading: "Loading FITS file",
  classifying: "Classifying target",
  background: "Removing background",
  calibration: "Color calibration",
  stretch: "Applying stretch",
  stars: "Star reduction",
  noise: "Noise reduction",
  saving: "Saving files",
  complete: "Complete",
};

interface ProcessingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageId: string;
  objectName?: string;
  currentTargetType?: string;
  onProcess?: (result: ProcessImageResponse) => void;
}

export function ProcessingDialog({
  open,
  onOpenChange,
  imageId,
  objectName,
  currentTargetType,
  onProcess,
}: ProcessingDialogProps) {
  // Form state
  const [targetType, setTargetType] = useState("auto");
  const [stretchMethod, setStretchMethod] = useState("statistical");
  const [stretchFactor, setStretchFactor] = useState(0.15);
  const [backgroundRemoval, setBackgroundRemoval] = useState(true);
  const [starReduction, setStarReduction] = useState(false);
  const [colorCalibration, setColorCalibration] = useState(true);
  const [noiseReduction, setNoiseReduction] = useState(0);
  const [contrast, setContrast] = useState(1.3);

  // UI state
  const [isProcessing, setIsProcessing] = useState(false);
  const [isClassifying, setIsClassifying] = useState(false);
  const [detectedTarget, setDetectedTarget] = useState<TargetInfo | null>(null);

  // Progress state
  const [progressStep, setProgressStep] = useState("");
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // Set up progress event listener
  useEffect(() => {
    let mounted = true;

    const setupListener = async () => {
      // Clean up previous listener if any
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      if (!isProcessing) return;

      try {
        const unlisten = await listen<ProcessingProgressEvent>(
          "image-processing-progress",
          (event) => {
            if (!mounted) return;
            // Only update if this is for our image
            if (event.payload.imageId === imageId) {
              setProgressStep(event.payload.step);
              setProgressPercent(event.payload.progress * 100);
              setProgressMessage(event.payload.message);
            }
          },
        );
        if (mounted) {
          unlistenRef.current = unlisten;
        } else {
          unlisten();
        }
      } catch (err) {
        console.error("Failed to set up progress listener:", err);
      }
    };

    setupListener();

    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [isProcessing, imageId]);

  // Auto-classify target when dialog opens
  useEffect(() => {
    if (open && objectName && targetType === "auto") {
      classifyTarget();
    }
  }, [open, objectName]);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setTargetType(currentTargetType || "auto");
      setStretchMethod("statistical");
      setStretchFactor(0.15);
      setBackgroundRemoval(true);
      setStarReduction(false);
      setColorCalibration(true);
      setNoiseReduction(0);
      setContrast(1.3);
      setDetectedTarget(null);
    }
  }, [open, currentTargetType]);

  // Update defaults when target type changes
  useEffect(() => {
    if (targetType && targetType !== "auto") {
      loadDefaults(targetType);
    }
  }, [targetType]);

  const classifyTarget = useCallback(async () => {
    if (!objectName) return;

    setIsClassifying(true);
    try {
      const info = await imageProcessApi.classifyTarget(objectName);
      setDetectedTarget(info);
      if (info.confidence >= 0.7 && targetType === "auto") {
        // Don't auto-switch target type, just show the detection
      }
    } catch (err) {
      console.error("Failed to classify target:", err);
    } finally {
      setIsClassifying(false);
    }
  }, [objectName, targetType]);

  const loadDefaults = useCallback(async (type: string) => {
    try {
      const defaults = await imageProcessApi.getDefaults(type);
      setStretchFactor(defaults.stretchFactor);
      setBackgroundRemoval(defaults.backgroundRemoval);
      setStarReduction(defaults.starReduction);
      setColorCalibration(defaults.colorCalibration);
    } catch (err) {
      console.error("Failed to load defaults:", err);
    }
  }, []);

  const handleProcess = async () => {
    if (!imageId) return;

    // Reset progress state
    setProgressStep("");
    setProgressPercent(0);
    setProgressMessage("");
    setIsProcessing(true);
    try {
      const input: ProcessImageInput = {
        id: imageId,
        targetType: targetType === "auto" ? undefined : targetType,
        stretchMethod,
        stretchFactor,
        backgroundRemoval,
        starReduction,
        colorCalibration,
        noiseReduction,
        contrast,
      };

      const result = await imageProcessApi.process(input);

      if (result.success) {
        toast.success(
          `Image processed in ${result.processingTime.toFixed(1)}s`,
        );
        onProcess?.(result);
        onOpenChange(false);
      } else {
        toast.error(result.errorMessage || "Processing failed");
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      toast.error("Processing failed: " + errorMsg);
      console.error("Processing error:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  const getTargetTypeLabel = (type: string) => {
    return TARGET_TYPES.find((t) => t.value === type)?.label || type;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="w-5 h-5" />
            Process Image
          </DialogTitle>
          <DialogDescription>
            Apply stretch and enhancements to your FITS image. The processed
            image will be saved alongside the original.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Target Detection */}
          {objectName && (
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Object</Label>
                <p className="font-medium">{objectName}</p>
              </div>
              {isClassifying ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              ) : detectedTarget ? (
                <div className="text-right space-y-1">
                  <Badge variant="secondary">
                    {getTargetTypeLabel(detectedTarget.targetType)}
                  </Badge>
                  <p className="text-xs text-muted-foreground">
                    {(detectedTarget.confidence * 100).toFixed(0)}% confidence
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {/* Target Type */}
          <div className="space-y-2">
            <Label htmlFor="target-type">Target Type</Label>
            <Select value={targetType} onValueChange={setTargetType}>
              <SelectTrigger id="target-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TARGET_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Different target types use optimized processing settings
            </p>
          </div>

          {/* Stretch Method */}
          <div className="space-y-2">
            <Label htmlFor="stretch-method">Stretch Method</Label>
            <Select value={stretchMethod} onValueChange={setStretchMethod}>
              <SelectTrigger id="stretch-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRETCH_METHODS.map((method) => (
                  <SelectItem key={method.value} value={method.value}>
                    {method.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stretch Factor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="stretch-factor">Stretch Factor</Label>
              <span className="text-sm text-muted-foreground">
                {(stretchFactor * 100).toFixed(0)}%
              </span>
            </div>
            <Slider
              id="stretch-factor"
              min={5}
              max={30}
              step={1}
              value={[stretchFactor * 100]}
              onValueChange={(v) => setStretchFactor(v[0] / 100)}
            />
            <p className="text-xs text-muted-foreground">
              Higher values create a more aggressive stretch (brighter midtones)
            </p>
          </div>

          {/* Contrast */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="contrast">Contrast</Label>
              <span className="text-sm text-muted-foreground">
                {contrast === 1.0
                  ? "Off"
                  : contrast.toFixed(1) + "x"}
              </span>
            </div>
            <Slider
              id="contrast"
              min={10}
              max={20}
              step={1}
              value={[contrast * 10]}
              onValueChange={(v) => setContrast(v[0] / 10)}
            />
            <p className="text-xs text-muted-foreground">
              Adjust image contrast (1.3x matches Seestar output)
            </p>
          </div>

          {/* Toggles */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="bg-removal">Background Removal</Label>
                <p className="text-xs text-muted-foreground">
                  Remove light pollution gradient
                </p>
              </div>
              <Switch
                id="bg-removal"
                checked={backgroundRemoval}
                onCheckedChange={setBackgroundRemoval}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="star-reduction">Star Reduction</Label>
                <p className="text-xs text-muted-foreground">
                  Reduce star brightness to emphasize nebulosity
                </p>
              </div>
              <Switch
                id="star-reduction"
                checked={starReduction}
                onCheckedChange={setStarReduction}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="color-cal">Color Calibration</Label>
                <p className="text-xs text-muted-foreground">
                  Neutralize background color cast
                </p>
              </div>
              <Switch
                id="color-cal"
                checked={colorCalibration}
                onCheckedChange={setColorCalibration}
              />
            </div>
          </div>

          {/* Noise Reduction */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="noise-reduction">Noise Reduction</Label>
              <span className="text-sm text-muted-foreground">
                {noiseReduction === 0
                  ? "Off"
                  : `${(noiseReduction * 100).toFixed(0)}%`}
              </span>
            </div>
            <Slider
              id="noise-reduction"
              min={0}
              max={100}
              step={5}
              value={[noiseReduction * 100]}
              onValueChange={(v) => setNoiseReduction(v[0] / 100)}
            />
            <p className="text-xs text-muted-foreground">
              Light Gaussian blur to reduce noise (may soften details)
            </p>
          </div>
        </div>

        {/* Progress Section - shown during processing */}
        {isProcessing && (
          <div className="space-y-3 p-4 bg-muted/50 rounded-lg border">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-teal-500" />
                <span className="font-medium">
                  {STEP_LABELS[progressStep] || progressStep || "Processing..."}
                </span>
              </div>
              <span className="text-sm text-muted-foreground">
                {progressPercent.toFixed(0)}%
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
            {progressMessage && (
              <p className="text-xs text-muted-foreground">{progressMessage}</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleProcess} disabled={isProcessing}>
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Process Image
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
