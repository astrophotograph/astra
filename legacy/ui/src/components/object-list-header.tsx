// Object List Header Component
import {SortDirection, SortField} from "@/components/todo-list-types"
import {ArrowRightLeft, ChevronDown, ChevronUp} from "lucide-react"

interface ObjectListHeaderProps {
  sortField: SortField | null;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}

export function ObjectListHeader({sortField, sortDirection, onSort}: ObjectListHeaderProps) {
  // Get sort icon based on field and direction
  const getSortIcon = (field: SortField) => {
    if (sortField !== field || sortDirection === null) {
      return <ArrowRightLeft className="ml-1 h-4 w-4 opacity-20"/>
    }
    return sortDirection === "asc"
      ? <ChevronUp className="ml-1 h-4 w-4"/>
      : <ChevronDown className="ml-1 h-4 w-4"/>
  }

  return (
    <div className="grid grid-cols-12 font-medium p-4 bg-muted">
      <div className="col-span-1">Status</div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("name")}
      >
        Name {getSortIcon("name")}
      </div>
      <div className="col-span-1">Type</div>
      <div className="col-span-1">RA</div>
      <div className="col-span-1">Dec</div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("magnitude")}
      >
        Magnitude {getSortIcon("magnitude")}
      </div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("size")}
      >
        Size {getSortIcon("size")}
      </div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("altitude")}
      >
        Altitude {getSortIcon("altitude")}
      </div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("azimuth")}
      >
        Direction {getSortIcon("azimuth")}
      </div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("maxTime")}
      >
        Peak Time {getSortIcon("maxTime")}
      </div>
      <div
        className="col-span-1 flex items-center cursor-pointer"
        onClick={() => onSort("goalTime")}
      >
        Goal Time {getSortIcon("goalTime")}
      </div>
      <div className="col-span-1 text-right">Actions</div>
    </div>
  )
}
