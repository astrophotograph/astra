// Update the EmptyState component to include a message for the flagged tab
interface EmptyStateProps {
  activeTab: string;
  hasFilters: boolean;
}

export function EmptyState({ activeTab, hasFilters }: EmptyStateProps) {
  let message = "No astronomy objects found.";
  let subMessage = "Add an object to your observation list to get started.";

  if (hasFilters) {
    message = "No matching objects found.";
    subMessage = "Try changing your filters to see more objects.";
  } else if (activeTab === "pending") {
    message = "No pending objects.";
    subMessage = "All your objects have been observed!";
  } else if (activeTab === "completed") {
    message = "No completed observations yet.";
    subMessage = "Mark objects as completed after you observe them.";
  } else if (activeTab === "flagged") {
    message = "No flagged objects.";
    subMessage = "Flag important objects to prioritize your observations.";
  }

  return (
    <div className="text-center py-12 border rounded-lg bg-muted/30">
      <p className="text-lg font-medium">{message}</p>
      <p className="text-muted-foreground mt-1">{subMessage}</p>
    </div>
  );
}
