/**
 * Live GPU stretch preview: WebGL2 canvas + parameter sliders.
 *
 * Fetches the pre-stretch float payload once (`get_stretch_data`), then
 * every slider move recomputes the MTF solution and redraws on the GPU —
 * no Rust round-trip until Apply, which hands the chosen parameters to the
 * existing `regenerate_preview` pipeline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, X, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { imageApi } from "@/lib/tauri/commands";
import { parseStretchPayload } from "@/lib/stretch/mtf-solution";
import { StretchRenderer } from "@/lib/stretch/renderer";

interface StretchPreviewProps {
  imageId: string;
  initialBgPercent: number;
  initialSigma: number;
  /** Apply is running (disables controls, shows spinner). */
  isApplying: boolean;
  /** greenRemoval/saturation are undefined for mono images (both are
   *  color-only no-ops in the pipeline). */
  onApply: (
    bgPercent: number,
    sigma: number,
    greenRemoval?: number,
    saturation?: number,
  ) => void;
  onCancel: () => void;
  /** Payload fetch or WebGL2 setup failed — caller falls back to presets. */
  onUnavailable: (reason: string) => void;
}

export function StretchPreview({
  imageId,
  initialBgPercent,
  initialSigma,
  isApplying,
  onApply,
  onCancel,
  onUnavailable,
}: StretchPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StretchRenderer | null>(null);
  const rafRef = useRef(0);
  const [isLoading, setIsLoading] = useState(true);
  const [bgPercent, setBgPercent] = useState(initialBgPercent);
  const [sigma, setSigma] = useState(initialSigma);
  // Color-only cosmetic params; seeded from the payload header's pipeline
  // defaults once it arrives (isColor stays false for mono, hiding them)
  const [isColor, setIsColor] = useState(false);
  const [greenRemoval, setGreenRemoval] = useState(0.5);
  const [saturation, setSaturation] = useState(1.25);

  // Latest values for the load effect to render once ready, without
  // re-triggering the payload fetch when sliders move
  const paramsRef = useRef({ bgPercent, sigma });
  paramsRef.current = { bgPercent, sigma };

  useEffect(() => {
    let cancelled = false;

    setIsLoading(true);
    imageApi
      .getStretchData(imageId)
      .then((buf) => {
        if (cancelled || !canvasRef.current) return;
        const payload = parseStretchPayload(buf);
        const renderer = new StretchRenderer(canvasRef.current, payload);
        rendererRef.current = renderer;
        setIsColor(renderer.isColor);
        if (renderer.isColor) {
          setGreenRemoval(payload.greenRemoval);
          setSaturation(payload.saturation);
        }
        // Header values are what the sliders now show, so passing them
        // explicitly and defaulting them inside setParams are equivalent
        renderer.setParams(paramsRef.current.bgPercent, paramsRef.current.sigma);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!cancelled) onUnavailable(String(err));
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // onUnavailable intentionally omitted: identity changes must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  // Coalesce slider updates to one redraw per frame
  const scheduleRender = useCallback(
    (bg: number, sig: number, green: number, sat: number) => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rendererRef.current?.setParams(bg, sig, green, sat);
      });
    },
    [],
  );

  const handleBgChange = (value: number) => {
    setBgPercent(value);
    scheduleRender(value, sigma, greenRemoval, saturation);
  };

  const handleSigmaChange = (value: number) => {
    setSigma(value);
    scheduleRender(bgPercent, value, greenRemoval, saturation);
  };

  const handleGreenChange = (value: number) => {
    setGreenRemoval(value);
    scheduleRender(bgPercent, sigma, value, saturation);
  };

  const handleSaturationChange = (value: number) => {
    setSaturation(value);
    scheduleRender(bgPercent, sigma, greenRemoval, value);
  };

  return (
    <div className="space-y-2">
      <div className="rounded-lg overflow-hidden bg-muted relative">
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1 bg-slate-900/80 border border-border text-slate-100 text-xs px-2 h-7 rounded">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          Live stretch
        </div>
        {isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 aspect-video">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
            <p className="text-sm text-muted-foreground">Loading FITS data…</p>
          </div>
        )}
        {/* Cap at 70vh so portrait frames can't push the sliders below the
            fold; object-contain letterboxes instead of distorting */}
        <canvas
          ref={canvasRef}
          className={`w-full h-auto max-h-[70vh] object-contain block ${isLoading ? "invisible" : ""}`}
        />
      </div>

      <div className="rounded-lg border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-3 min-w-[220px] flex-1">
          <span className="text-xs text-muted-foreground whitespace-nowrap w-24">
            Background {(bgPercent * 100).toFixed(0)}%
          </span>
          <Slider
            value={[bgPercent]}
            min={0.02}
            max={0.5}
            step={0.005}
            disabled={isLoading || isApplying}
            onValueChange={([v]) => handleBgChange(v)}
          />
        </div>
        <div className="flex items-center gap-3 min-w-[220px] flex-1">
          <span className="text-xs text-muted-foreground whitespace-nowrap w-24">
            Shadows σ {sigma.toFixed(1)}
          </span>
          <Slider
            value={[sigma]}
            min={0}
            max={5}
            step={0.1}
            disabled={isLoading || isApplying}
            onValueChange={([v]) => handleSigmaChange(v)}
          />
        </div>
        {isColor && (
          <>
            <div className="flex items-center gap-3 min-w-[220px] flex-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap w-24">
                SCNR {(greenRemoval * 100).toFixed(0)}%
              </span>
              <Slider
                value={[greenRemoval]}
                min={0}
                max={1}
                step={0.05}
                disabled={isLoading || isApplying}
                onValueChange={([v]) => handleGreenChange(v)}
              />
            </div>
            <div className="flex items-center gap-3 min-w-[220px] flex-1">
              <span className="text-xs text-muted-foreground whitespace-nowrap w-24">
                Saturation {saturation.toFixed(2)}
              </span>
              <Slider
                value={[saturation]}
                min={0}
                max={2}
                step={0.05}
                disabled={isLoading || isApplying}
                onValueChange={([v]) => handleSaturationChange(v)}
              />
            </div>
          </>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={isApplying}
          >
            <X className="w-4 h-4 mr-1" />
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onApply(
                bgPercent,
                sigma,
                isColor ? greenRemoval : undefined,
                isColor ? saturation : undefined,
              )
            }
            disabled={isLoading || isApplying}
          >
            {isApplying ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Check className="w-4 h-4 mr-1" />
            )}
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
