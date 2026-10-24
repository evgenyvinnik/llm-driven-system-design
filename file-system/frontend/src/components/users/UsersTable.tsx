import type { RestoreResult, UserSummary } from '@/types'
import { UserRow } from './UserRow'

interface UsersTableProps {
  users: UserSummary[]
  onChanged: () => void
  onRestored: (result: RestoreResult) => void
}

export function UsersTable({ users, onChanged, onRestored }: UsersTableProps) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">User</th>
            <th className="th">Usage</th>
            <th className="th">Files</th>
            <th className="th">Backup</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <UserRow key={user.id} user={user} onChanged={onChanged} onRestored={onRestored} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
