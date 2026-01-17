import type { EncodedVariant } from '../../types';
import { getResolutionLabel } from '../../utils';

/**
 * Props for the QualitySettings component.
 */
interface QualitySettingsProps {
  /** Whether the settings panel is visible */
  isOpen: boolean;
  /** Available quality variants for the content */
  variants: EncodedVariant[];
  /** Currently selected quality variant */
  selectedVariant: EncodedVariant | null;
  /** Callback fired when a variant is selected */
  onSelectVariant: (variant: EncodedVariant) => void;
  /** Callback to close the settings panel */
  onClose: () => void;
}

/**
 * Quality settings dropdown panel for video player.
 * Displays available video quality options with HDR indicators.
 * Allows user to manually select streaming quality.
 *
 * @param props - QualitySettingsProps with variants and selection handlers
 * @returns Quality selection dropdown menu (null if closed)
 */
export function QualitySettings({
  isOpen,
  variants,
  selectedVariant,
  onSelectVariant,
  onClose,
}: QualitySettingsProps) {
  if (!isOpen) {
    return null;
  }

  /**
   * Handles variant selection and closes the panel.
   *
   * @param variant - The selected quality variant
   */
  const handleSelect = (variant: EncodedVariant) => {
    onSelectVariant(variant);
    onClose();
  };

  return (
    <div className="absolute bottom-full right-0 mb-2 w-64 bg-black/90 backdrop-blur rounded-lg p-4">
      <h3 className="text-sm font-medium mb-2">Quality</h3>
      <div className="space-y-1">
        {variants.map((variant) => (
          <QualityOption
            key={variant.id}
            variant={variant}
            isSelected={selectedVariant?.id === variant.id}
            onSelect={() => handleSelect(variant)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Props for the QualityOption component.
 */
interface QualityOptionProps {
  /** Quality variant data */
  variant: EncodedVariant;
  /** Whether this option is currently selected */
  isSelected: boolean;
  /** Callback fired when this option is clicked */
  onSelect: () => void;
}

/**
 * Individual quality option in the settings panel.
 * Displays resolution label and HDR/SDR indicator.
 *
 * @param props - QualityOptionProps with variant and selection state
 * @returns Clickable quality option button
 */
function QualityOption({ variant, isSelected, onSelect }: QualityOptionProps) {
  const baseClasses = 'w-full flex items-center justify-between px-3 py-2 rounded text-sm';
  const stateClasses = isSelected ? 'bg-white/20' : 'hover:bg-white/10';

  return (
    <button onClick={onSelect} className={`${baseClasses} ${stateClasses}`}>
      <span>{getResolutionLabel(variant.resolution)}</span>
      <span className="text-white/60">{variant.hdr ? 'HDR' : 'SDR'}</span>
    </button>
  );
}
