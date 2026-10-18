import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatDate } from '../../lib/format.js';

export default function Members() {
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [error, setError] = useState(null);

  const load = useCallback(() => api.members().then(setData), []);
  useEffect(() => {
    load();
  }, [load]);

  const invite = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await api.invite({ email, role });
      setEmail('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Members</h1>
        <p>People who can use the Workbench, manage keys and see usage.</p>
      </div>
      <div className="card">
        <h2>Invite a member</h2>
        <form className="row" onSubmit={invite}>
          <input type="email" aria-label="Email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} style={{ maxWidth: 320 }} />
          <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value)} style={{ maxWidth: 160 }}>
            <option value="developer">Developer</option>
            <option value="admin">Admin</option>
            <option value="billing">Billing</option>
            <option value="viewer">Viewer</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={!email}>
            Send invite
          </button>
        </form>
        {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      </div>
      <div className="card">
        <h2>Members</h2>
        {!data && <div className="muted">Loading…</div>}
        {data && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td className="muted">{member.email}</td>
                  <td>
                    <span className="badge">{member.role}</span>
                  </td>
                  <td className="muted">{formatDate(member.joinedAt)}</td>
                </tr>
              ))}
              {data.invites.map((invite) => (
                <tr key={invite.id}>
                  <td className="muted">Invited</td>
                  <td className="muted">{invite.email}</td>
                  <td>
                    <span className="badge">{invite.role}</span>
                  </td>
                  <td className="muted">Pending</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
