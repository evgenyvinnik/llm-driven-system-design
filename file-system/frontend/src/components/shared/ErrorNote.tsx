export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</p>
}
