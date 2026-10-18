import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useAppData } from '../../lib/appData.jsx';
import { toast } from '../../lib/toast.js';
import { formatDate } from '../../lib/format.js';

export default function Organization() {
  const { me } = useAppData();
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (me) setName(me.org.name);
  }, [me]);

  const save = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      await api.updateOrg({ name });
      toast('Organization name saved. Refresh to see it everywhere.');
    } catch (err) {
      setError(err.message);
    }
  };

  if (!me) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-header">
        <h1>Organization</h1>
        <p>Settings shared by everyone in {me.org.name}.</p>
      </div>
      <div className="card" style={{ maxWidth: 560 }}>
        <form onSubmit={save}>
          <div className="field">
            <label htmlFor="org-name">Name</label>
            <input id="org-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label>Organization ID</label>
            <div className="mono muted">{me.org.id}</div>
          </div>
          <div className="field">
            <label>Created</label>
            <div className="muted">{formatDate(me.org.createdAt)}</div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || name === me.org.name}>
            Save
          </button>
        </form>
      </div>
    </>
  );
}
