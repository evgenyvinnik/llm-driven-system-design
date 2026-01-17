import { SpotlightModal } from './components/SpotlightModal';
import { useKeyboardShortcut } from './hooks/useKeyboardShortcut';
import { useSpotlightStore } from './stores/spotlightStore';
import { Search, Command } from 'lucide-react';

function App() {
  useKeyboardShortcut();
  const { openSpotlight } = useSpotlightStore();

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Background pattern */}
      <div className="fixed inset-0 opacity-30">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 25px 25px, rgba(255,255,255,0.1) 2px, transparent 0)`,
          backgroundSize: '50px 50px'
        }} />
      </div>

      {/* Main content */}
      <div className="relative flex flex-col items-center justify-center min-h-screen px-4">
        <div className="text-center mb-12">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="p-4 rounded-2xl bg-blue-500/20 border border-blue-500/30">
              <Search className="w-12 h-12 text-blue-400" />
            </div>
          </div>
          <h1 className="text-5xl font-bold text-white mb-4">
            Spotlight Search
          </h1>
          <p className="text-xl text-gray-400 max-w-lg">
            Universal search across files, apps, contacts, and the web.
            Fast, intelligent, and privacy-focused.
          </p>
        </div>

        {/* Open button */}
        <button
          onClick={openSpotlight}
          className="group flex items-center gap-4 px-6 py-4 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 transition-all duration-200"
        >
          <Search className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
          <span className="text-gray-400 group-hover:text-white transition-colors">
            Click here or press
          </span>
          <kbd className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-black/40 border border-white/10 text-gray-300">
            <Command className="w-4 h-4" />
            <span>K</span>
          </kbd>
        </button>

        {/* Features grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-20 max-w-4xl w-full">
          <FeatureCard
            title="Multi-Source Search"
            description="Search files, applications, contacts, and web content all in one place."
            icon="files"
          />
          <FeatureCard
            title="Smart Calculations"
            description="Quick math calculations and unit conversions right from the search bar."
            icon="calculator"
          />
          <FeatureCard
            title="Intelligent Suggestions"
            description="Proactive suggestions based on your usage patterns and time of day."
            icon="sparkles"
          />
        </div>

        {/* Instructions */}
        <div className="mt-16 p-6 rounded-xl bg-white/5 border border-white/10 max-w-2xl w-full">
          <h2 className="text-lg font-semibold text-white mb-4">Try These Searches</h2>
          <div className="grid grid-cols-2 gap-4">
            <ExampleSearch query="Safari" description="Find apps" />
            <ExampleSearch query="meeting notes" description="Search files" />
            <ExampleSearch query="alice" description="Find contacts" />
            <ExampleSearch query="2+2*3" description="Calculate" />
            <ExampleSearch query="100 km to miles" description="Convert units" />
            <ExampleSearch query="github" description="Search web" />
          </div>
        </div>
      </div>

      <SpotlightModal />
    </div>
  );
}

function FeatureCard({ title, description, icon }: { title: string; description: string; icon: string }) {
  const icons: Record<string, React.ReactNode> = {
    files: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    ),
    calculator: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    ),
    sparkles: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
      </svg>
    ),
  };

  return (
    <div className="p-6 rounded-xl bg-white/5 border border-white/10">
      <div className="p-3 rounded-lg bg-blue-500/20 text-blue-400 w-fit mb-4">
        {icons[icon]}
      </div>
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      <p className="text-sm text-gray-400">{description}</p>
    </div>
  );
}

function ExampleSearch({ query, description }: { query: string; description: string }) {
  const { setQuery, openSpotlight } = useSpotlightStore();

  const handleClick = () => {
    openSpotlight();
    setTimeout(() => setQuery(query), 100);
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center justify-between p-3 rounded-lg bg-black/20 hover:bg-black/40 transition-colors text-left group"
    >
      <code className="text-blue-400 text-sm">{query}</code>
      <span className="text-xs text-gray-500 group-hover:text-gray-400 transition-colors">{description}</span>
    </button>
  );
}

export default App;
