/**
 * LoadingState - A centered loading spinner component.
 * Used as a placeholder while data is being fetched.
 */
export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
