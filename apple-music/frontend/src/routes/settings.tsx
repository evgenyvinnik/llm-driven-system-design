import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/settings')({
  component: Settings,
});

function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  if (!user) {
    navigate({ to: '/login' });
    return null;
  }

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Settings</h1>

      {/* Account Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Account</h2>
        <div className="bg-apple-card rounded-xl p-6 space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <p className="font-medium">{user.displayName}</p>
              <p className="text-sm text-apple-text-secondary">{user.email}</p>
            </div>
            <span className="px-3 py-1 bg-apple-red/20 text-apple-red rounded-full text-sm capitalize">
              {user.subscriptionTier}
            </span>
          </div>

          <div className="pt-4 border-t border-apple-border">
            <p className="text-sm text-apple-text-secondary mb-1">Username</p>
            <p>{user.username}</p>
          </div>

          <div className="pt-4 border-t border-apple-border">
            <p className="text-sm text-apple-text-secondary mb-1">Role</p>
            <p className="capitalize">{user.role}</p>
          </div>
        </div>
      </section>

      {/* Audio Quality Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Audio Quality</h2>
        <div className="bg-apple-card rounded-xl p-6 space-y-4">
          <div>
            <p className="font-medium mb-2">Preferred Quality</p>
            <p className="text-sm text-apple-text-secondary mb-4">
              Choose your default audio quality for streaming
            </p>
            <select
              defaultValue={user.preferredQuality}
              className="w-full px-4 py-3 bg-apple-bg border border-apple-border rounded-lg focus:outline-none focus:border-apple-red"
            >
              <option value="256_aac">High Quality (256 kbps AAC)</option>
              <option value="lossless">Lossless (ALAC up to 24-bit/48kHz)</option>
              <option value="hi_res_lossless">Hi-Res Lossless (ALAC up to 24-bit/192kHz)</option>
            </select>
          </div>

          <div className="pt-4 border-t border-apple-border">
            <p className="text-sm text-apple-text-secondary">
              Note: Hi-Res Lossless requires a compatible external DAC.
              Streaming quality may be reduced on cellular networks.
            </p>
          </div>
        </div>
      </section>

      {/* Subscription Section */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Subscription</h2>
        <div className="bg-apple-card rounded-xl p-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <p className="font-medium capitalize">{user.subscriptionTier} Plan</p>
              <p className="text-sm text-apple-text-secondary">
                {user.subscriptionTier === 'free'
                  ? 'Limited features'
                  : 'Full access to all features'}
              </p>
            </div>
            {user.subscriptionTier === 'free' && (
              <button className="px-4 py-2 bg-apple-red hover:bg-apple-red/80 rounded-lg font-medium transition">
                Upgrade
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="p-4 bg-apple-bg rounded-lg">
              <p className="font-medium mb-1">Max Quality</p>
              <p className="text-apple-text-secondary">
                {user.subscriptionTier === 'free' ? '256 kbps' : 'Hi-Res Lossless'}
              </p>
            </div>
            <div className="p-4 bg-apple-bg rounded-lg">
              <p className="font-medium mb-1">Offline Downloads</p>
              <p className="text-apple-text-secondary">
                {user.subscriptionTier === 'free' ? 'Not available' : 'Unlimited'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Sign Out */}
      <section>
        <button
          onClick={handleLogout}
          className="w-full py-3 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition"
        >
          Sign Out
        </button>
      </section>
    </div>
  );
}
