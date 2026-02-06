// Sync status indicator component
import {Button} from "@/components/ui/button"
import {RefreshCw} from "lucide-react"

interface SyncStatusProps {
  lastSyncTime: Date | null;
  isSyncing: boolean;
  onSync: () => void;
  isAuthenticated: boolean;
}

export function SyncStatus({lastSyncTime, isSyncing, onSync, isAuthenticated}: SyncStatusProps) {
  if (!isAuthenticated) {
    return (
      <div className="flex items-center text-sm text-muted-foreground">
        <span>Working in offline mode</span>
      </div>
    )
  }

  return (
    <div className="flex items-center space-x-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onSync}
        disabled={isSyncing}
        className="flex items-center space-x-1"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`}/>
        <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>
      </Button>
      <span className="text-xs text-muted-foreground">
        {lastSyncTime
          ? `Last synced: ${lastSyncTime.toLocaleTimeString()}`
          : 'Not yet synced'}
      </span>
    </div>
  )
}
