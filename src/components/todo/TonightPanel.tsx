/**
 * TonightPanel — the "Tonight" hero of the Todo page: suggested imaging
 * order (timeline) beside a sky dome of current positions.
 */

import { formatTime } from "@/lib/astronomy-utils";
import type { HorizonProfile } from "@/lib/astronomy-utils";
import type { ImagingOrder } from "@/lib/imaging-order";
import type { MoonData } from "@/lib/moon";
import { SkyDome, type SkyDomeObject } from "@/components/SkyDome";
import { TonightTimeline } from "./TonightTimeline";

interface TonightPanelProps {
  order: ImagingOrder;
  moon: MoonData | null;
  objects: SkyDomeObject[];
  horizon: HorizonProfile | null;
  selectedId: string | null;
  onSelectObject: (id: string) => void;
}

const NIGHT_LABEL: Record<ImagingOrder["night"]["source"], string> = {
  astronomical: "Astronomical night",
  nautical: "Nautical night",
  civil: "Civil night",
  fallback: "No astronomical darkness — using",
};

export function TonightPanel({
  order,
  moon,
  objects,
  horizon,
  selectedId,
  onSelectObject,
}: TonightPanelProps) {
  const hasTonight = order.slots.some(
    (s) => s.status === "tonight" || s.status === "already-set",
  );

  return (
    <section className="rounded-xl border border-border bg-slate-800/50 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-1">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
            Tonight's imaging order
          </p>
          <h2 className="font-serif text-2xl font-light tracking-wide text-slate-100">
            Tonight
          </h2>
        </div>
        <p className="text-xs text-slate-500 font-mono">
          {NIGHT_LABEL[order.night.source]} {formatTime(order.night.dusk)} –{" "}
          {formatTime(order.night.dawn)}
        </p>
      </div>

      {!order.usedFlaggedOnly && hasTonight && (
        <p className="text-xs text-muted-foreground mb-3">
          No flagged targets — showing all pending objects visible tonight. Flag
          objects to curate the sequence.
        </p>
      )}

      {hasTonight ? (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_auto] gap-6 items-start mt-3">
          <TonightTimeline
            order={order}
            selectedId={selectedId}
            onSelectObject={onSelectObject}
          />
          <SkyDome
            objects={objects}
            moon={moon}
            horizon={horizon}
            selectedId={selectedId}
            onSelectObject={onSelectObject}
            className="justify-self-center lg:w-[280px]"
          />
        </div>
      ) : (
        <div className="py-8 text-center">
          <p className="font-serif text-lg text-slate-300">
            Nothing on tonight's list
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {order.slots.length === 0
              ? "Add objects and flag the ones you want to image tonight."
              : "None of your pending objects clear the horizon tonight."}
          </p>
        </div>
      )}
    </section>
  );
}
