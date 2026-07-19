/**
 * Slim sortable todo list. Filtering/sorting state lives in the page;
 * this renders the header row + rows.
 */

import { ArrowUpDown, ChevronDown, ChevronUp, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import type { TodoVisibility } from "@/hooks/use-todo-visibility";
import type { ImagingSlot } from "@/lib/imaging-order";
import { ROW_GRID, TodoRow } from "./TodoRow";

export type SortField =
  | "name"
  | "altitude"
  | "direction"
  | "moonDistance"
  | "window"
  | "goalTime";
export type SortDirection = "asc" | "desc";

interface TodoListProps {
  todos: AstronomyTodo[];
  visibility: Map<string, TodoVisibility>;
  slotByTodoId: Map<string, ImagingSlot>;
  expandedId: string | null;
  highlightedId: string | null;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  onToggleExpand: (id: string) => void;
  onToggleComplete: (todo: AstronomyTodo) => void;
  onToggleFlag: (todo: AstronomyTodo) => void;
  onDelete: (todo: AstronomyTodo) => void;
  onEdit: (todo: AstronomyTodo) => void;
  onSetGoal: (todo: AstronomyTodo) => void;
  onShowAltitude: (todo: AstronomyTodo) => void;
  onTagClick: (tag: string) => void;
  emptyMessage: string;
  loading: boolean;
}

export function TodoList({
  todos,
  visibility,
  slotByTodoId,
  expandedId,
  highlightedId,
  sortField,
  sortDirection,
  onSort,
  onToggleExpand,
  onToggleComplete,
  onToggleFlag,
  onDelete,
  onEdit,
  onSetGoal,
  onShowAltitude,
  onTagClick,
  emptyMessage,
  loading,
}: TodoListProps) {
  const SortHeader = ({
    field,
    children,
    className,
  }: {
    field: SortField;
    children: React.ReactNode;
    className?: string;
  }) => (
    <button
      className={cn("flex items-center gap-1 hover:text-slate-100 transition-colors", className)}
      onClick={() => onSort(field)}
    >
      {children}
      {sortField === field ? (
        sortDirection === "asc" ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-50" />
      )}
    </button>
  );

  if (loading) {
    return (
      <div className="text-center py-12 rounded-xl border border-border bg-slate-800/50">
        <p className="text-muted-foreground">Loading observation list...</p>
      </div>
    );
  }

  if (todos.length === 0) {
    return (
      <div className="text-center py-12 rounded-xl border border-border bg-slate-800/50">
        <p className="font-serif text-lg text-slate-300">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-slate-800/50 overflow-hidden">
      {/* Header row */}
      <div
        className={cn(
          ROW_GRID,
          "py-2 bg-slate-800/80 text-xs font-medium text-muted-foreground border-b border-border",
        )}
      >
        <div />
        <SortHeader field="name">Name</SortHeader>
        <SortHeader field="altitude">Alt</SortHeader>
        <SortHeader field="direction" className="hidden lg:flex">
          Dir
        </SortHeader>
        <SortHeader field="moonDistance" className="hidden lg:flex">
          <Moon className="w-3 h-3" />
        </SortHeader>
        <SortHeader field="window">Window</SortHeader>
        <SortHeader field="goalTime" className="hidden lg:flex">
          Goal
        </SortHeader>
        <div className="text-right">Actions</div>
      </div>

      <div className="divide-y divide-border">
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            visibility={visibility.get(todo.id)}
            slot={slotByTodoId.get(todo.id)}
            expanded={expandedId === todo.id}
            highlighted={highlightedId === todo.id}
            onToggleExpand={onToggleExpand}
            onToggleComplete={onToggleComplete}
            onToggleFlag={onToggleFlag}
            onDelete={onDelete}
            onEdit={onEdit}
            onSetGoal={onSetGoal}
            onShowAltitude={onShowAltitude}
            onTagClick={onTagClick}
          />
        ))}
      </div>
    </div>
  );
}
