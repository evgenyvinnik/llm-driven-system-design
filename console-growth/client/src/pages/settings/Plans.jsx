import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import Modal from '../../components/Modal.jsx';
import { toast } from '../../lib/toast.js';

export default function Plans() {
  const [data, setData] = useState(null);
  const [contacting, setContacting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.plans().then(setData).catch(() => {});
  }, []);

  const send = async (event) => {
    event.preventDefault();
    await api.contactSales(message);
    setContacting(false);
    setMessage('');
    toast('Thanks — our team will be in touch within one business day.');
  };

  if (!data) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-header">
        <h1>Plans</h1>
        <p>Choose how your organization pays for the API.</p>
      </div>
      <div className="grid grid-2">
        {data.plans.map((plan) => (
          <div key={plan.id} className="card">
            <div className="card-header">
              <h2>{plan.name}</h2>
              {plan.id === data.current && <span className="badge badge-accent">Current plan</span>}
            </div>
            <p className="muted">{plan.summary}</p>
            <ul>
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            {plan.id !== data.current && (
              <button className="btn" type="button" onClick={() => setContacting(true)}>
                Contact sales
              </button>
            )}
          </div>
        ))}
      </div>
      {contacting && (
        <Modal title="Talk to us about Scale" onClose={() => setContacting(false)}>
          <form onSubmit={send}>
            <div className="field">
              <label htmlFor="sales-message">What are you building?</label>
              <textarea id="sales-message" value={message} onChange={(event) => setMessage(event.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setContacting(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit">
                Send
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
