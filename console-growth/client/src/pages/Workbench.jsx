import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import { useAppData } from '../lib/appData.jsx';
import { track } from '../lib/instrumentation.js';
import { formatCents, formatNumber } from '../lib/format.js';

function codeSnippet({ model, system, prompt, temperature, maxTokens }) {
  const body = { model, max_tokens: maxTokens, temperature, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] };
  return `curl https://api.console.example/v1/messages \\
  -H "x-api-key: $CONSOLE_API_KEY" \\
  -H "content-type: application/json" \\
  -d '${JSON.stringify(body, null, 2).replace(/'/g, "'\\''")}'`;
}

export default function Workbench() {
  const { billing, refreshBilling } = useAppData();
  const [models, setModels] = useState([]);
  const [form, setForm] = useState({
    model: 'nova-medium',
    system: '',
    prompt: 'Explain the difference between a rate limit and a spend limit in two sentences.',
    temperature: 1,
    maxTokens: 512,
  });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    api.models().then((data) => setModels(data.models)).catch(() => {});
  }, []);

  const update = (field) => (event) => {
    const value = event.target.type === 'number' || event.target.type === 'range' ? Number(event.target.value) : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const run = async (event) => {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResult(await api.complete(form));
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setRunning(false);
      refreshBilling();
    }
  };

  const openCode = () => {
    track('workbench_get_code_clicked', { model: form.model });
    setShowCode(true);
  };

  return (
    <>
      <div className="page-header">
        <h1>Workbench</h1>
        <p>Try a prompt against any model. Runs are billed to your credit balance like API calls.</p>
      </div>
      <form className="workbench" onSubmit={run}>
        <div className="stack">
          <div className="card">
            <div className="field">
              <label htmlFor="system">System prompt</label>
              <textarea id="system" rows={2} value={form.system} onChange={update('system')} placeholder="Optional instructions for the model" />
            </div>
            <div className="field">
              <label htmlFor="prompt">User message</label>
              <textarea id="prompt" rows={5} value={form.prompt} onChange={update('prompt')} />
            </div>
            <div className="row">
              <button className="btn btn-primary" type="submit" disabled={running || !form.prompt.trim()}>
                {running ? 'Running…' : 'Run'}
              </button>
              <button className="btn" type="button" onClick={openCode}>
                Get code
              </button>
              <span className="spacer" />
              <span className="muted small">Balance: {billing ? formatCents(billing.balanceCents) : '—'}</span>
            </div>
          </div>
          <div className="card">
            <h2>Response</h2>
            {error && (
              <div className="notice notice-error">
                {error.message} {error.type === 'credit_balance_too_low' && <Link to="/settings/billing">Go to Billing</Link>}
              </div>
            )}
            {!error && !result && <div className="muted">Run a prompt to see the model’s response.</div>}
            {result && (
              <>
                <div className="output">{result.output}</div>
                <div className="muted small" style={{ marginTop: 12 }}>
                  {formatNumber(result.usage.inputTokens)} input · {formatNumber(result.usage.outputTokens)} output tokens · cost{' '}
                  {formatCents(result.costCents)} · {result.stopReason}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="card">
          <div className="field">
            <label htmlFor="model">Model</label>
            <select id="model" value={form.model} onChange={update('model')}>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <div className="field-hint">{models.find((model) => model.id === form.model)?.description}</div>
          </div>
          <div className="field">
            <label htmlFor="temperature">Temperature: {form.temperature}</label>
            <input id="temperature" type="range" min="0" max="1" step="0.1" value={form.temperature} onChange={update('temperature')} />
          </div>
          <div className="field">
            <label htmlFor="maxTokens">Max tokens</label>
            <input id="maxTokens" type="number" min="1" max="4096" value={form.maxTokens} onChange={update('maxTokens')} />
          </div>
        </div>
      </form>
      {showCode && (
        <Modal title="Get code" onClose={() => setShowCode(false)}>
          <p className="muted">
            Call the API with this request. You need an <Link to="/keys">API key</Link>.
          </p>
          <pre className="code">{codeSnippet(form)}</pre>
          <div className="modal-actions">
            <button className="btn" type="button" onClick={() => setShowCode(false)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
