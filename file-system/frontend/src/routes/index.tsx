import { useEffect, useRef } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Breadcrumbs, DirectoryTable, DirSummary, LargestFiles, NewFileForm } from '@/components/files'
import { ErrorNote } from '@/components/shared'
import { useDirectory, useNearestDirectory } from '@/hooks/useDirectory'
import { useToasts } from '@/stores/toast-store'
import { useUsers } from '@/stores/users-store'

interface FilesSearch {
  path: string
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): FilesSearch => ({
    path: typeof search.path === 'string' && search.path.startsWith('/') ? search.path : '/',
  }),
  component: FilesPage,
})

function FilesPage() {
  const { path } = Route.useSearch()
  const navigate = useNavigate()
  const push = useToasts((s) => s.push)
  const { listing, largest, error, vanished, reload } = useDirectory(path)
  const notADirectory = error?.code === 'NOT_A_DIRECTORY'
  const nearest = useNearestDirectory(path, notADirectory)
  const loadUsers = useUsers((s) => s.load)
  const handledVanish = useRef<string | null>(null)

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  // The folder disappeared while on screen (its last file was deleted): move up
  // to the closest folder that still exists rather than showing an error.
  useEffect(() => {
    if (!vanished || nearest === null || handledVanish.current === path) return
    handledVanish.current = path
    push('success', `${path} no longer exists: its last file was removed`)
    void navigate({ to: '/', search: { path: nearest }, replace: true })
  }, [vanished, nearest, path, navigate, push])

  const changed = () => {
    void reload()
    void loadUsers()
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <Breadcrumbs path={path} />
      </div>
      {error ? (
        <div className="space-y-3">
          <ErrorNote
            message={notADirectory ? `${path} isn't a folder. Folders exist only while a file is stored below them.` : error.message}
          />
          {nearest !== null && (
            <Link to="/" search={{ path: nearest }} className="btn-secondary">
              Go to {nearest}
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <div>{listing ? <DirectoryTable listing={listing} onChanged={changed} /> : <p className="text-sm text-slate-500">Loading…</p>}</div>
          <aside className="space-y-4">
            {listing && <DirSummary listing={listing} />}
            <LargestFiles path={path} files={largest} />
            <NewFileForm dir={path} onCreated={changed} />
          </aside>
        </div>
      )}
    </main>
  )
}
