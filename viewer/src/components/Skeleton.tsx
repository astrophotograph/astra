export function Skeleton() {
  return (
    <div class="skeleton-grid">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} class="skeleton-item" />
      ))}
    </div>
  );
}
