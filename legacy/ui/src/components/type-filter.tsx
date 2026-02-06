// Type Filter Component
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover"
import {Button} from "@/components/ui/button"
import {Filter} from "lucide-react"
import {Checkbox} from "@/components/ui/checkbox"
import {Label} from "@/components/ui/label"

interface TypeFilterProps {
  availableTypes: string[];
  selectedTypes: string[];
  onTypeFilterChange: (type: string) => void;
  onClearFilters: () => void;
}

export function TypeFilter({
                             availableTypes,
                             selectedTypes,
                             onTypeFilterChange,
                             onClearFilters,
                           }: TypeFilterProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          <Filter className="h-4 w-4 mr-2"/>
          Filter Types {selectedTypes.length > 0 && `(${selectedTypes.length})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-4" align="end">
        <div className="space-y-4">
          <h4 className="font-medium">Object Types</h4>
          <div className="space-y-2">
            {availableTypes.map(type => (
              <div key={type} className="flex items-center space-x-2">
                <Checkbox
                  id={`type-${type}`}
                  checked={selectedTypes.includes(type)}
                  onCheckedChange={() => onTypeFilterChange(type)}
                />
                <Label htmlFor={`type-${type}`} className="text-sm cursor-pointer">
                  {type}
                </Label>
              </div>
            ))}
          </div>
          {selectedTypes.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onClearFilters}
            >
              Clear Filters
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
