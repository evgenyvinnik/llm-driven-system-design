import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { HardDriveIcon, UsersIcon } from '@/components/icons'
import { api } from '@/services/api'
import type { StoreKind } from '@/types'

const navClass = 'btn-ghost px-3 [&.active]:bg-accent-50 [&.active]:text-accent-700'

export function AppHeader() {
  const [store, setStore] = useState<StoreKind | null>(null)

  useEffect(() => {
    api
      .info()
      .then(({ store }) => setStore(store))
      .catch(() => setStore(null))
  }, [])

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
        <Link to="/" search={{ path: '/' }} className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-700 text-accent-100">
            <HardDriveIcon className="h-4 w-4" />
          </span>
          File System
        </Link>
        <nav className="flex items-center gap-1">
          <Link to="/" search={{ path: '/' }} className={navClass} activeOptions={{ includeSearch: false }}>
            <HardDriveIcon /> Files
          </Link>
          <Link to="/users" className={navClass}>
            <UsersIcon /> Users
          </Link>
        </nav>
        {store && (
          <span
            className="chip ml-auto bg-slate-100 text-slate-600"
            title={store === 'postgres' ? 'Namespace stored in PostgreSQL' : 'In-memory store (npm run dev:memory)'}
          >
            {store === 'postgres' ? 'PostgreSQL' : 'In-memory'} store
          </span>
        )}
      </div>
    </header>
  )
}
