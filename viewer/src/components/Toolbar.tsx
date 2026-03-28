import type { SortMode } from "../types";

interface Props {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sortMode: SortMode;
  onSortChange: (m: SortMode) => void;
  favOnly: boolean;
  onFavToggle: () => void;
  shownCount: number;
}

export function Toolbar({
  searchQuery,
  onSearchChange,
  sortMode,
  onSortChange,
  favOnly,
  onFavToggle,
  shownCount,
}: Props) {
  return (
    <div class="toolbar">
      <input
        type="text"
        class="search-box"
        placeholder="Search by name or catalog ID..."
        value={searchQuery}
        onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
      />
      <select
        value={sortMode}
        onChange={(e) =>
          onSortChange((e.target as HTMLSelectElement).value as SortMode)
        }
      >
        <option value="date-desc">Newest first</option>
        <option value="date-asc">Oldest first</option>
        <option value="name-asc">Name A–Z</option>
        <option value="name-desc">Name Z–A</option>
      </select>
      <button
        class={`fav-toggle ${favOnly ? "active" : ""}`}
        onClick={onFavToggle}
        title="Show favorites only"
      >
        <span>&#9733;</span> Favorites
      </button>
      <span class="image-count">{shownCount} shown</span>
    </div>
  );
}
