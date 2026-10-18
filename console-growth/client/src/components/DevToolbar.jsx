// The Dev panel (bottom right): force experiment variants, watch analytics events live, and
// reset the seeded data. Development tooling, not part of the product.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useExperiments } from '../lib/experiments.jsx';
import { clearOverrides, setOverride } from '../lib/overrides.js';

const MAX_EVENTS = 200;
const TABS = ['experiments', 'events', 'data'];

function ExperimentsTab() {
  const { experiments, error } = useExperiments();
  if (error) return <p className="dev-muted">Couldn’t load experiments: {error.message}</p>;
  if (!experiments) return <p className="dev-muted">Loading…</p>;

  return (
    <>
      {experiments.map((experiment) => (
        <div key={experiment.key} className="dev-exp">
          <div className="row">
            <span className="dev-exp-key">{experiment.key}</span>
            <span className="spacer" />
            <select
              aria-label={`Variant for ${experiment.key}`}
              value={experiment.overridden ? experiment.variant : ''}
              onChange={(event) => setOverride(experiment.key, event.target.value || null)}
            >
              <option value="">assigned ({experiment.assigned})</option>
              {experiment.variants.map((variant) => (
                <option key={variant} value={variant}>
                  {variant}
                </option>
              ))}
            </select>
          </div>
          <div className="dev-muted" style={{ marginTop: 4 }}>
            {experiment.description}
          </div>
          <div className="dev-muted" style={{ marginTop: 4 }}>
            unit: {experiment.unit} ({experiment.unitId}) · weights {experiment.weights.join('/')} · now{' '}
            <strong style={{ color: '#fff' }}>{experiment.variant}</strong>
            {experiment.overridden ? ' (forced)' : ''}
            {experiment.enabled ? '' : ' · disabled'}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="dev-btn" onClick={clearOverrides}>
          Clear overrides
        </button>
        <span className="dev-muted">Overrides apply to API requests too. Refresh if a page read a variant server-side.</span>
      </div>
    </>
  );
}

function EventsTab({ events, onClear }) {
  const [filter, setFilter] = useState('');
  const visible = events.filter((record) => record.event.includes(filter.trim()));
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <input placeholder="Filter by event name" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <span className="spacer" />
        <button type="button" className="dev-btn" onClick={onClear}>
          Clear
        </button>
      </div>
      {visible.length === 0 && <p className="dev-muted">No events yet. Click around.</p>}
      {visible.map((record) => (
        <div key={record.id} className="dev-event">
          <div className="row">
            <span className={`dev-event-name${record.event === '$exposure' ? ' exposure' : ''}`}>{record.event}</span>
            <span className="dev-muted">{record.source}</span>
            <span className="spacer" />
            <span className="dev-muted">{new Date(record.ts).toLocaleTimeString()}</span>
          </div>
          <pre>{JSON.stringify(record.props)}</pre>
        </div>
      ))}
    </>
  );
}

function DataTab({ onClearEvents }) {
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    setBusy(true);
    await api.resetData();
    window.location.reload();
  };
  const simulateDay = async () => {
    setBusy(true);
    await api.simulateUsage(1);
    window.location.reload();
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        <button type="button" className="dev-btn" onClick={reset} disabled={busy}>
          Reset data to seed
        </button>
        <div className="dev-muted" style={{ marginTop: 4 }}>
          Restores Northwind Labs’ balance, keys, usage and settings. Events are kept.
        </div>
      </div>
      <div>
        <button type="button" className="dev-btn" onClick={simulateDay} disabled={busy}>
          Simulate a day of API traffic
        </button>
        <div className="dev-muted" style={{ marginTop: 4 }}>
          Spends one day of the org’s recent usage from its balance, an hour at a time: shows auto-reload firing or the balance running out.
        </div>
      </div>
      <div>
        <button type="button" className="dev-btn" onClick={onClearEvents}>
          Clear event log
        </button>
      </div>
    </div>
  );
}

export default function DevToolbar() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('experiments');
  const [events, setEvents] = useState([]);
  const [streaming, setStreaming] = useState(false);

  // Connect on first open, not on page load: the stream replays recent events on connect, and
  // an always-open connection keeps the page from ever going network-idle (which test and
  // screenshot tools wait for). It stays connected once opened.
  const toggle = () => {
    setOpen((value) => !value);
    setStreaming(true);
  };

  useEffect(() => {
    if (!streaming || typeof EventSource === 'undefined') return undefined;
    const source = new EventSource('/api/events/stream');
    source.onmessage = (message) => {
      const record = JSON.parse(message.data);
      // The stream replays recent events on reconnect, so skip ones already shown.
      setEvents((current) => (current.some((existing) => existing.id === record.id) ? current : [record, ...current].slice(0, MAX_EVENTS)));
    };
    return () => source.close();
  }, [streaming]);

  const clearEvents = async () => {
    await api.clearEvents();
    setEvents([]);
  };

  return (
    <>
      {open && (
        <div className="dev-panel" role="dialog" aria-label="Dev toolbar">
          <div className="dev-tabs">
            {TABS.map((name) => (
              <button key={name} type="button" className={`dev-tab${tab === name ? ' active' : ''}`} onClick={() => setTab(name)}>
                {name[0].toUpperCase() + name.slice(1)}
                {name === 'events' ? ` (${events.length})` : ''}
              </button>
            ))}
          </div>
          <div className="dev-body">
            {tab === 'experiments' && <ExperimentsTab />}
            {tab === 'events' && <EventsTab events={events} onClear={clearEvents} />}
            {tab === 'data' && <DataTab onClearEvents={clearEvents} />}
          </div>
        </div>
      )}
      <button type="button" className="dev-toggle" onClick={toggle}>
        Dev
      </button>
    </>
  );
}
