/**
 * Tabs + type/tag filters + visibility toggle for the todo list.
 * Purely presentational — all state lives in the page.
 */

import { Eye, Filter, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";

export type TabValue = "all" | "pending" | "flagged" | "completed";

interface TodoFilterBarProps {
  activeTab: TabValue;
  onTabChange: (tab: TabValue) => void;
  counts: { all: number; pending: number; flagged: number; completed: number };
  uniqueTypes: string[];
  typeFilters: Set<string>;
  onToggleType: (type: string) => void;
  onClearTypes: () => void;
  uniqueTags: string[];
  tagFilters: Set<string>;
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  hideNotVisible: boolean;
  onToggleHideNotVisible: () => void;
}

export function TodoFilterBar({
  activeTab,
  onTabChange,
  counts,
  uniqueTypes,
  typeFilters,
  onToggleType,
  onClearTypes,
  uniqueTags,
  tagFilters,
  onToggleTag,
  onClearTags,
  hideNotVisible,
  onToggleHideNotVisible,
}: TodoFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="all">All ({counts.all})</TabsTrigger>
          <TabsTrigger value="pending">Pending ({counts.pending})</TabsTrigger>
          <TabsTrigger value="flagged">Flagged ({counts.flagged})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({counts.completed})</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="w-4 h-4 mr-2" />
              Types
              {typeFilters.size > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {typeFilters.size}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Object Types</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {uniqueTypes.map((type) => (
              <DropdownMenuCheckboxItem
                key={type}
                checked={typeFilters.has(type)}
                onCheckedChange={() => onToggleType(type)}
              >
                {getObjectTypeInfo(type).label}
              </DropdownMenuCheckboxItem>
            ))}
            {typeFilters.size > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onClearTypes}>Clear filters</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Tag className="w-4 h-4 mr-2" />
              Tags
              {tagFilters.size > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {tagFilters.size}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Tags</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {uniqueTags.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No tags yet</div>
            ) : (
              uniqueTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={tagFilters.has(tag)}
                  onCheckedChange={() => onToggleTag(tag)}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))
            )}
            {tagFilters.size > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onClearTags}>Clear filters</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant={hideNotVisible ? "default" : "outline"}
          size="sm"
          onClick={onToggleHideNotVisible}
          title="Hide objects not visible tonight"
        >
          <Eye className="w-4 h-4 mr-2" />
          Visible Tonight
        </Button>
      </div>
    </div>
  );
}
