/**
 * QualitySelector Component
 *
 * Dropdown menu for selecting video quality/bitrate.
 * Shows current quality selection and available options.
 */
import React from 'react';
import { Settings } from 'lucide-react';
import type { StreamQuality } from '../../types';

/** Props for the QualitySelector component */
interface QualitySelectorProps {
  /** Currently selected quality level */
  currentQuality: StreamQuality | null;
  /** List of available quality options */
  availableQualities: StreamQuality[] | undefined;
  /** Callback when a quality is selected */
  onQualitySelect: (quality: StreamQuality) => void;
}

/**
 * Quality selection dropdown menu.
 * Displays a settings icon button that opens a menu of available qualities.
 *
 * @param props - QualitySelector properties
 * @returns JSX element for quality selection
 */
export function QualitySelector({
  currentQuality,
  availableQualities,
  onQualitySelect,
}: QualitySelectorProps) {
  const [showMenu, setShowMenu] = React.useState(false);

  /**
   * Handles quality option selection.
   * Calls the onQualitySelect callback and closes the menu.
   */
  const handleSelect = (quality: StreamQuality) => {
    onQualitySelect(quality);
    setShowMenu(false);
  };

  /**
   * Formats bitrate for display (converts to Mbps).
   */
  const formatBitrate = (bitrate: number): string => {
    return `${Math.round(bitrate / 1000)}Mbps`;
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="text-white hover:text-netflix-light-gray flex items-center gap-1"
        aria-label="Quality settings"
        aria-expanded={showMenu}
        aria-haspopup="menu"
      >
        <Settings size={24} />
        <span className="text-sm">{currentQuality?.quality || 'Auto'}</span>
      </button>

      {showMenu && availableQualities && (
        <div
          className="absolute bottom-full right-0 mb-2 bg-black/90 rounded py-2 min-w-32"
          role="menu"
        >
          {availableQualities.map((quality) => (
            <button
              key={quality.quality}
              onClick={() => handleSelect(quality)}
              className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-700 ${
                currentQuality?.quality === quality.quality
                  ? 'text-netflix-red'
                  : 'text-white'
              }`}
              role="menuitem"
              aria-selected={currentQuality?.quality === quality.quality}
            >
              {quality.quality} ({formatBitrate(quality.bitrate)})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
