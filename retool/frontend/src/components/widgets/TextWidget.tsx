import { useMemo } from 'react';
import type { AppComponent } from '../../types';
import { useBindingContext } from '../../stores/dataStore';
import { resolveBindings, hasBindings } from '../../utils/bindings';

interface TextWidgetProps {
  component: AppComponent;
  isEditor?: boolean;
}

/** Renders a text display widget with binding-resolved content. */
export function TextWidget({ component }: TextWidgetProps) {
  const context = useBindingContext();

  const rawValue = (component.props.value as string) || '';
  const fontSize = (component.props.fontSize as number) || 14;
  const fontWeight = (component.props.fontWeight as string) || 'normal';
  const color = (component.props.color as string) || '#1C1C1E';

  const displayValue = useMemo(() => {
    if (hasBindings(rawValue)) {
      return resolveBindings(rawValue, context);
    }
    return rawValue;
  }, [rawValue, context]);

  return (
    <div className="flex items-center h-full px-3 py-2">
      <span
        style={{ fontSize, fontWeight, color }}
        className="break-words"
      >
        {displayValue || 'Text'}
      </span>
    </div>
  );
}
