/**
 * One slim todo row + its expandable detail. Reference data (RA/Dec/mag/
 * size) lives in the detail; the row keeps only tonight-relevant columns.
 */

import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Edit,
  Flag,
  LineChart,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";
import { formatTime } from "@/lib/astronomy-utils";
import { altitudeColorClass } from "@/lib/status-colors";
import type { TodoVisibility } from "@/hooks/use-todo-visibility";
import type { ImagingSlot } from "@/lib/imaging-order";
import { parseTags } from "./tags";

export const ROW_GRID = cn(
  "grid items-center gap-3 px-4",
  "grid-cols-[32px_minmax(140px,1fr)_84px_104px_152px]",
  "lg:grid-cols-[32px_minmax(160px,1fr)_84px_56px_60px_104px_76px_152px]",
);

interface TodoRowProps {
  todo: AstronomyTodo;
  visibility: TodoVisibility | undefined;
  slot: ImagingSlot | undefined;
  expanded: boolean;
  highlighted: boolean;
  onToggleExpand: (id: string) => void;
  onToggleComplete: (todo: AstronomyTodo) => void;
  onToggleFlag: (todo: AstronomyTodo) => void;
  onDelete: (todo: AstronomyTodo) => void;
  onEdit: (todo: AstronomyTodo) => void;
  onSetGoal: (todo: AstronomyTodo) => void;
  onShowAltitude: (todo: AstronomyTodo) => void;
  onTagClick: (tag: string) => void;
}

export function TodoRow({
  todo,
  visibility: v,
  slot,
  expanded,
  highlighted,
  onToggleExpand,
  onToggleComplete,
  onToggleFlag,
  onDelete,
  onEdit,
  onSetGoal,
  onShowAltitude,
  onTagClick,
}: TodoRowProps) {
  const typeInfo = getObjectTypeInfo(todo.object_type || "Unknown");
  const tags = parseTags(todo.tags);

  const windowLabel = v?.window
    ? `${formatTime(v.window.start)}–${formatTime(v.window.end)}`
    : null;
  const peakLabel = v?.peakTime ? formatTime(v.peakTime) : null;

  return (
    <div
      id={`todo-row-${todo.id}`}
      className={cn(
        "group transition-colors",
        highlighted && "ring-1 ring-inset ring-teal-400/60",
      )}
    >
      <div
        className={cn(
          ROW_GRID,
          "py-3 text-sm hover:bg-slate-700/30 cursor-pointer",
          todo.completed && "opacity-60",
        )}
        onClick={(e) => {
          // Row click expands, unless an interactive child was the target.
          if ((e.target as HTMLElement).closest("button, [role=checkbox], a")) return;
          onToggleExpand(todo.id);
        }}
      >
        {/* Status */}
        <div>
          <Checkbox
            checked={todo.completed}
            onCheckedChange={() => onToggleComplete(todo)}
          />
        </div>

        {/* Name */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-500" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />
            )}
            <span className="font-medium truncate text-slate-100">{todo.name}</span>
            {todo.flagged && (
              <Flag className="w-3 h-3 shrink-0 text-indigo-400 fill-indigo-400" />
            )}
            {slot?.order != null && (
              <span className="shrink-0 font-mono text-[10px] text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 rounded px-1 leading-4">
                #{slot.order}
              </span>
            )}
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] px-1.5 py-0 h-4 truncate max-w-[120px] hidden md:inline-flex"
              style={{
                backgroundColor: typeInfo.color + "20",
                borderColor: typeInfo.color,
              }}
            >
              {typeInfo.label}
            </Badge>
          </div>
          {v?.neverVisible ? (
            <div
              className="text-xs text-red-400/90 truncate pl-[22px]"
              title={`Max altitude tonight: ${v.maxAltitude?.toFixed(1)}°`}
            >
              Not visible tonight (max {v.maxAltitude?.toFixed(0)}°)
            </div>
          ) : v?.notVisibleRestOfNight ? (
            <div
              className="text-xs text-amber-400 truncate pl-[22px]"
              title="Already set — won't rise above threshold again tonight"
            >
              Not visible rest of night
            </div>
          ) : todo.notes ? (
            <div className="text-xs text-muted-foreground truncate pl-[22px]">{todo.notes}</div>
          ) : null}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1 pl-[22px]">
              {tags.sort().map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className="text-xs px-1.5 py-0 h-4 cursor-pointer hover:bg-accent"
                  onClick={() => onTagClick(tag)}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Altitude + trend */}
        <div className={cn("font-medium tabular-nums", altitudeColorClass(v?.altitude ?? null))}>
          <span className="inline-flex items-center gap-0.5">
            {v?.altitude != null ? `${v.altitude.toFixed(0)}°` : "—"}
            {v?.altitude != null && v.trend === "rising" && (
              <ChevronUp className="w-3 h-3 text-teal-400" aria-label="rising" />
            )}
            {v?.altitude != null && v.trend === "setting" && (
              <ChevronDown className="w-3 h-3 text-amber-400" aria-label="setting" />
            )}
          </span>
        </div>

        {/* Direction (lg+) */}
        <div className="hidden lg:block text-muted-foreground">{v?.direction || "—"}</div>

        {/* Moon separation (lg+) */}
        <div
          className={cn(
            "hidden lg:block tabular-nums",
            v?.moonDistance != null && v.moonDistance < 30
              ? "text-amber-400"
              : "text-muted-foreground",
          )}
          title={v?.moonDistance != null ? `${v.moonDistance.toFixed(1)}° from moon` : undefined}
        >
          {v?.moonDistance != null ? `${v.moonDistance.toFixed(0)}°` : "—"}
        </div>

        {/* Window / peak */}
        <div className="text-xs">
          {windowLabel ? (
            <>
              <div className="text-slate-300 font-mono">{windowLabel}</div>
              {peakLabel && (
                <div className="text-muted-foreground font-mono">↑{peakLabel}</div>
              )}
            </>
          ) : peakLabel ? (
            <div className="text-muted-foreground font-mono">↑{peakLabel}</div>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>

        {/* Goal (lg+) */}
        <div className="hidden lg:block text-muted-foreground truncate text-xs">
          {todo.goal_time || "—"}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onShowAltitude(todo)}
            title="View altitude and add to schedule"
          >
            <LineChart className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onToggleFlag(todo)}
            title={todo.flagged ? "Remove flag" : "Flag"}
          >
            <Flag className={cn("w-4 h-4", todo.flagged && "fill-indigo-400 text-indigo-400")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onSetGoal(todo)}
            title="Set goal time"
          >
            <Clock className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onEdit(todo)}
            title="Edit"
          >
            <Edit className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(todo)}
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <TodoRowDetail
          todo={todo}
          visibility={v}
          onShowAltitude={onShowAltitude}
          onSetGoal={onSetGoal}
          onTagClick={onTagClick}
        />
      )}
    </div>
  );
}

interface TodoRowDetailProps {
  todo: AstronomyTodo;
  visibility: TodoVisibility | undefined;
  onShowAltitude: (todo: AstronomyTodo) => void;
  onSetGoal: (todo: AstronomyTodo) => void;
  onTagClick: (tag: string) => void;
}

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.15em] text-slate-500">{label}</div>
      <div className="font-mono text-xs text-slate-300 mt-0.5">{value}</div>
    </div>
  );
}

function TodoRowDetail({ todo, visibility: v, onShowAltitude, onSetGoal, onTagClick }: TodoRowDetailProps) {
  const tags = parseTags(todo.tags);
  return (
    <div className="bg-slate-800/60 border-t border-border px-4 py-4 pl-[68px]">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3">
        <DetailItem label="RA" value={todo.ra !== "N/A" ? todo.ra : "—"} />
        <DetailItem label="Dec" value={todo.dec !== "N/A" ? todo.dec : "—"} />
        <DetailItem label="Magnitude" value={todo.magnitude !== "N/A" ? todo.magnitude : "—"} />
        <DetailItem label="Size" value={todo.size !== "N/A" ? todo.size : "—"} />
        <DetailItem
          label="Azimuth"
          value={v?.azimuth != null ? `${v.azimuth.toFixed(0)}° ${v.direction ?? ""}` : "—"}
        />
        <DetailItem
          label="Max alt tonight"
          value={v?.maxAltitude != null ? `${v.maxAltitude.toFixed(0)}°` : "—"}
        />
      </div>
      {todo.notes && (
        <p className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">{todo.notes}</p>
      )}
      {todo.completed && todo.completed_at && (
        <p className="mt-2 text-xs text-teal-400">
          Observed {new Date(todo.completed_at).toLocaleDateString()}
        </p>
      )}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {tags.sort().map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="text-xs px-1.5 py-0 h-4 cursor-pointer hover:bg-accent"
              onClick={() => onTagClick(tag)}
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2 mt-4">
        <Button variant="outline" size="sm" onClick={() => onShowAltitude(todo)}>
          <LineChart className="w-3.5 h-3.5 mr-1.5" />
          Altitude chart
        </Button>
        <Button variant="outline" size="sm" onClick={() => onSetGoal(todo)}>
          <Clock className="w-3.5 h-3.5 mr-1.5" />
          Set goal
        </Button>
      </div>
    </div>
  );
}
