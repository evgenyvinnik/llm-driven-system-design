/**
 * Visual progress indicator for multi-step forms.
 * Displays a horizontal bar divided into segments representing each step.
 */
import { TOTAL_STEPS } from './types';

interface ProgressIndicatorProps {
  /** Current step number (1-indexed) */
  currentStep: number;
  /** Total number of steps (defaults to TOTAL_STEPS) */
  totalSteps?: number;
}

/**
 * Renders a progress indicator showing how far through a wizard the user is.
 * Completed and current steps are highlighted, future steps are dimmed.
 *
 * @param props - Component props
 * @returns JSX element for the progress indicator
 *
 * @example
 * ```tsx
 * <ProgressIndicator currentStep={2} />
 * // Shows 4 segments, first 2 highlighted
 * ```
 */
export function ProgressIndicator({
  currentStep,
  totalSteps = TOTAL_STEPS,
}: ProgressIndicatorProps) {
  return (
    <div className="flex gap-2 mb-8">
      {Array.from({ length: totalSteps }, (_, index) => {
        const stepNumber = index + 1;
        const isCompleted = stepNumber <= currentStep;

        return (
          <div
            key={stepNumber}
            className={`flex-1 h-1 rounded ${
              isCompleted ? 'bg-airbnb' : 'bg-gray-200'
            }`}
            aria-label={`Step ${stepNumber} ${isCompleted ? 'completed' : 'incomplete'}`}
          />
        );
      })}
    </div>
  );
}
