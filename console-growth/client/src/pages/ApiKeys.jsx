import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import { formatDate, formatRelative } from '../lib/format.js';

function CreateKeyModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    try {
      const result = await api.createKey(name);
      setCreated(result);
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  };

  if (created) {
    return (
      <Modal title="Save your key" onClose={onClose}>
        <p className="muted">Copy it now. For security, you won’t be able to see it again.</p>
        <div className="secret mono">{created.secret}</div>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={() => navigator.clipboard?.writeText(created.secret)}>
            Copy
          </button>
          <button className="btn btn-primary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create API key" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="key-name">Name</label>
          <input id="key-name" type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. prod-backend" autoFocus />
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ApiKeys() {
  const [keys, setKeys] = useState(null);
  const [members, setMembers] = useState([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => api.keys().then((data) => setKeys(data.keys)), []);

  useEffect(() => {
    load();
    api.members().then((data) => setMembers(data.members)).catch(() => {});
  }, [load]);

  const memberName = (id) => members.find((member) => member.id === id)?.name ?? id;

  const toggle = async (key) => {
    await api.updateKey(key.id, { status: key.status === 'active' ? 'disabled' : 'active' });
    load();
  };

  const remove = async (key) => {
    if (!window.confirm(`Delete "${key.name}"? Requests using it will start failing.`)) return;
    await api.deleteKey(key.id);
    load();
  };

  return (
    <>
      <div className="page-header row">
        <div>
          <h1>API keys</h1>
          <p>Keys authenticate API requests for Northwind Labs. Usage is billed to the organization.</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" type="button" onClick={() => setCreating(true)}>
          Create key
        </button>
      </div>
      <div className="card">
        {!keys && <div className="muted">Loading…</div>}
        {keys && keys.length === 0 && <div className="empty">No keys yet.</div>}
        {keys && keys.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created by</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono muted">{key.hint}</td>
                  <td>{memberName(key.createdBy)}</td>
                  <td className="muted">{formatDate(key.createdAt)}</td>
                  <td className="muted">{formatRelative(key.lastUsedAt)}</td>
                  <td>
                    <span className={`badge ${key.status === 'active' ? 'badge-success' : ''}`}>{key.status}</span>
                  </td>
                  <td className="num">
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => toggle(key)}>
                      {key.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                    <button className="btn btn-sm btn-ghost btn-danger" type="button" onClick={() => remove(key)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreateKeyModal onClose={() => setCreating(false)} onCreated={load} />}
    </>
  );
}
