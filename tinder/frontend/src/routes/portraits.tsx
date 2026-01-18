import { createFileRoute } from '@tanstack/react-router';
import ReignsAvatar from '../components/ReignsAvatar';

export const Route = createFileRoute('/portraits')({
  component: PortraitsPage,
});

/**
 * Portrait gallery showcasing the ReignsAvatar procedural generation.
 * Displays a grid of portraits with different seeds to demonstrate variety.
 */
function PortraitsPage() {
  // Sample seeds to generate diverse portraits
  const seeds = [
    'alice-johnson-1',
    'bob-smith-2',
    'carol-martinez-3',
    'david-chen-4',
    'emma-wilson-5',
    'frank-davis-6',
    'grace-lee-7',
    'henry-brown-8',
    'ivy-thompson-9',
    'jack-miller-10',
    'kate-anderson-11',
    'leo-garcia-12',
    'mia-rodriguez-13',
    'noah-williams-14',
    'olivia-taylor-15',
    'peter-jackson-16',
    'quinn-white-17',
    'rachel-thomas-18',
    'sam-harris-19',
    'tina-moore-20',
    'user-alpha-21',
    'user-beta-22',
    'user-gamma-23',
    'user-delta-24',
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-white text-center mb-2">
          ReignsAvatar Gallery
        </h1>
        <p className="text-gray-400 text-center mb-8">
          Procedural medieval-style portraits generated from seed strings
        </p>

        {/* Portrait Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {seeds.map((seed) => (
            <div
              key={seed}
              className="bg-gray-800 rounded-lg p-3 flex flex-col items-center shadow-lg hover:shadow-xl transition-shadow"
            >
              <ReignsAvatar seed={seed} size={150} className="rounded-lg" />
              <p className="mt-2 text-xs text-gray-400 truncate w-full text-center">
                {seed}
              </p>
            </div>
          ))}
        </div>

        {/* Large Featured Portraits */}
        <h2 className="text-2xl font-bold text-white text-center mt-12 mb-6">
          Featured Portraits
        </h2>
        <div className="flex flex-wrap justify-center gap-8">
          {['king-arthur-royal', 'queen-elizabeth-crown', 'knight-galahad-brave', 'lady-guinevere-fair'].map((seed) => (
            <div
              key={seed}
              className="bg-gray-800 rounded-xl p-6 flex flex-col items-center shadow-2xl"
            >
              <ReignsAvatar seed={seed} size={300} className="rounded-lg" />
              <p className="mt-4 text-sm text-gray-300 font-medium">
                {seed.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
