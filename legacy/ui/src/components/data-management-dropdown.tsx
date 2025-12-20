// Export/Import dropdown component
import {AstronomyObject} from "@/components/todo-list-types"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {Button} from "@/components/ui/button"
import {Download, FileDown, FileUp} from "lucide-react"

interface DataManagementDropdownProps {
  objects: AstronomyObject[];
  onExport: (format: 'json' | 'csv') => void;
  onImportClick: () => void;
}

export function DataManagementDropdown({objects, onExport, onImportClick}: DataManagementDropdownProps) {
  const exportDisabled = objects.length === 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="flex items-center space-x-1"
        >
          <FileDown className="h-3.5 w-3.5"/>
          <span>Import/Export</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={onImportClick}
          className="flex items-center space-x-2"
        >
          <FileUp className="h-3.5 w-3.5"/>
          <span>Import Data</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator/>
        <DropdownMenuItem
          onClick={() => onExport('json')}
          disabled={exportDisabled}
          className="flex items-center space-x-2"
        >
          <Download className="h-3.5 w-3.5"/>
          <span>Export as JSON</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onExport('csv')}
          disabled={exportDisabled}
          className="flex items-center space-x-2"
        >
          <Download className="h-3.5 w-3.5"/>
          <span>Export as CSV</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
