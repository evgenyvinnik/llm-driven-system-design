import { Fragment } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from '@/components/icons'
import { crumbs } from '@/lib/paths'

export function Breadcrumbs({ path }: { path: string }) {
  const parts = crumbs(path)
  return (
    <nav className="flex flex-wrap items-center gap-1 font-mono text-sm" aria-label="Breadcrumb">
      {parts.map((crumb, i) => (
        <Fragment key={crumb.path}>
          {i > 1 && <ChevronRightIcon className="h-3.5 w-3.5 text-slate-400" />}
          {i === parts.length - 1 ? (
            <span className="font-semibold text-slate-900">{crumb.name}</span>
          ) : (
            <Link to="/" search={{ path: crumb.path }} className="rounded px-1 text-accent-700 hover:bg-accent-50">
              {crumb.name}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  )
}
