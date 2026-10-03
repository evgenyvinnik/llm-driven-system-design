import { createLazyFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  CommandPalette,
  InlineFormTypeahead,
  MobileTypeahead,
  RichTypeahead,
  type CommandCategory,
} from '../components/widgets';
import { useSearchStore } from '../stores/search-store';

// Lazy route: the widgets (and the IndexedDB layer they use) load only when /widgets is visited
export const Route = createLazyFileRoute('/widgets')({
  component: WidgetsPage,
});

interface WidgetEvent {
  id: number;
  widget: string;
  kind: 'selected' | 'submitted';
  value: string;
}

/**
 * WidgetsPage - Demo of the four typeahead widget variants built on the useTypeahead hook
 * (debounce, request sequencing, IndexedDB fallback). The search page itself uses SearchBox
 * and the Zustand search store instead.
 */
function WidgetsPage() {
  const navigate = useNavigate();
  const userId = useSearchStore((state) => state.userId);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [events, setEvents] = useState<WidgetEvent[]>([]);

  const record = (widget: string, kind: WidgetEvent['kind']) => (value: string) => {
    setEvents((prev) => [{ id: Date.now() + Math.random(), widget, kind, value }, ...prev].slice(0, 8));
  };

  const commandCategories: CommandCategory[] = [
    {
      id: 'navigation',
      name: 'Navigation',
      commands: [
        { id: 'go-search', name: 'Go to Search', description: 'Open the search page', action: () => navigate({ to: '/' }) },
        { id: 'go-admin', name: 'Open Admin', description: 'Open the admin dashboard', action: () => navigate({ to: '/admin' }) },
      ],
    },
    {
      id: 'demo',
      name: 'Demo',
      commands: [
        { id: 'clear-events', name: 'Clear event log', description: 'Empty the widget event log below', action: () => setEvents([]) },
      ],
    },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Typeahead Widgets</h1>
        <p className="text-gray-600 mt-2">
          Four widget variants over the shared <code>useTypeahead</code> hook. Selections and
          submissions are logged to the backend like searches on the main page.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <WidgetCard title="Command palette" description="Modal Cmd/Ctrl+K palette mixing suggestions and commands.">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Open command palette <kbd className="ml-2 text-xs opacity-80">Ctrl K</kbd>
          </button>
          <CommandPalette
            isOpen={paletteOpen}
            onOpenChange={setPaletteOpen}
            categories={commandCategories}
            userId={userId}
            onSelect={record('Command palette', 'selected')}
            onSubmit={record('Command palette', 'submitted')}
          />
        </WidgetCard>

        <WidgetCard title="Inline form field" description="Typeahead inside a regular form; the form submits natively.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const topic = new FormData(e.currentTarget).get('topic');
              record('Inline form', 'submitted')(typeof topic === 'string' ? topic : '');
            }}
            className="flex items-end gap-3"
          >
            <InlineFormTypeahead
              name="topic"
              label="Topic"
              helperText="Pick a suggestion or type your own"
              userId={userId}
              onSelect={record('Inline form', 'selected')}
              className="flex-1"
            />
            <button type="submit" className="mb-7 px-4 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900">
              Save
            </button>
          </form>
        </WidgetCard>

        <WidgetCard title="Mobile overlay" description="Collapsed search button that expands to a full-screen dialog.">
          <MobileTypeahead
            title="Mobile search"
            userId={userId}
            onSelect={record('Mobile overlay', 'selected')}
            onSubmit={record('Mobile overlay', 'submitted')}
          />
        </WidgetCard>

        <WidgetCard title="Rich results" description="Counts, recency, fuzzy markers and the five ranking scores.">
          <RichTypeahead
            placeholder="Search with score breakdown..."
            userId={userId}
            showScores
            onSelect={record('Rich results', 'selected')}
            onSubmit={record('Rich results', 'submitted')}
          />
        </WidgetCard>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="font-semibold text-gray-900 mb-3">Event log</h2>
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">Select or submit something in a widget above.</p>
        ) : (
          <ul className="text-sm space-y-1" aria-live="polite">
            {events.map((event) => (
              <li key={event.id} className="text-gray-700">
                <span className="font-medium">{event.widget}</span> {event.kind}{' '}
                <span className="font-mono">"{event.value}"</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WidgetCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white rounded-lg shadow p-6">
      <h2 className="font-semibold text-gray-900">{title}</h2>
      <p className="text-sm text-gray-500 mb-4">{description}</p>
      {children}
    </section>
  );
}
