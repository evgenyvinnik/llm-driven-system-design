/**
 * Properties panel component for editing selected object attributes.
 * Provides controls for position, size, rotation, fill, stroke, opacity,
 * and type-specific properties like text content and font settings.
 */
import React, { useState } from 'react';
import { useEditorStore } from '../stores/editorStore';
import type { DesignObject } from '../types';

/**
 * PropertiesPanel component for editing design object properties.
 * Displays when a single object is selected, shows placeholder otherwise.
 * Changes are applied immediately via the editor store.
 * @returns The rendered properties panel element
 */
export function PropertiesPanel() {
  const { canvasData, selectedIds, updateObject } = useEditorStore();

  const selectedObject = selectedIds.length === 1
    ? canvasData.objects.find(o => o.id === selectedIds[0])
    : null;

  if (!selectedObject) {
    return (
      <div className="w-64 bg-figma-panel border-l border-figma-border p-4">
        <p className="text-figma-text-secondary text-sm text-center">
          Select an object to view its properties
        </p>
      </div>
    );
  }

  const handleChange = (property: keyof DesignObject, value: unknown) => {
    updateObject(selectedObject.id, { [property]: value });
  };

  return (
    <div className="w-64 bg-figma-panel border-l border-figma-border flex flex-col h-full overflow-y-auto">
      {/* Object type header */}
      <div className="px-4 py-3 border-b border-figma-border">
        <span className="text-figma-text font-medium text-sm capitalize">
          {selectedObject.type}
        </span>
      </div>

      {/* Name */}
      <PropertySection title="Name">
        <input
          type="text"
          value={selectedObject.name}
          onChange={(e) => handleChange('name', e.target.value)}
          className="w-full bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none"
        />
      </PropertySection>

      {/* Position */}
      <PropertySection title="Position">
        <div className="grid grid-cols-2 gap-2">
          <PropertyInput
            label="X"
            value={selectedObject.x}
            onChange={(v) => handleChange('x', v)}
          />
          <PropertyInput
            label="Y"
            value={selectedObject.y}
            onChange={(v) => handleChange('y', v)}
          />
        </div>
      </PropertySection>

      {/* Size */}
      <PropertySection title="Size">
        <div className="grid grid-cols-2 gap-2">
          <PropertyInput
            label="W"
            value={selectedObject.width}
            onChange={(v) => handleChange('width', v)}
            min={1}
          />
          <PropertyInput
            label="H"
            value={selectedObject.height}
            onChange={(v) => handleChange('height', v)}
            min={1}
          />
        </div>
      </PropertySection>

      {/* Rotation */}
      <PropertySection title="Rotation">
        <PropertyInput
          label="Angle"
          value={selectedObject.rotation}
          onChange={(v) => handleChange('rotation', v)}
          suffix="°"
        />
      </PropertySection>

      {/* Fill */}
      <PropertySection title="Fill">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={selectedObject.fill}
            onChange={(e) => handleChange('fill', e.target.value)}
            className="w-8 h-8 rounded border border-figma-border cursor-pointer"
          />
          <input
            type="text"
            value={selectedObject.fill}
            onChange={(e) => handleChange('fill', e.target.value)}
            className="flex-1 bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none uppercase"
          />
        </div>
      </PropertySection>

      {/* Stroke */}
      <PropertySection title="Stroke">
        <div className="flex items-center gap-2 mb-2">
          <input
            type="color"
            value={selectedObject.stroke}
            onChange={(e) => handleChange('stroke', e.target.value)}
            className="w-8 h-8 rounded border border-figma-border cursor-pointer"
          />
          <input
            type="text"
            value={selectedObject.stroke}
            onChange={(e) => handleChange('stroke', e.target.value)}
            className="flex-1 bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none uppercase"
          />
        </div>
        <PropertyInput
          label="Width"
          value={selectedObject.strokeWidth}
          onChange={(v) => handleChange('strokeWidth', v)}
          min={0}
          suffix="px"
        />
      </PropertySection>

      {/* Opacity */}
      <PropertySection title="Opacity">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={selectedObject.opacity}
            onChange={(e) => handleChange('opacity', parseFloat(e.target.value))}
            className="flex-1"
          />
          <span className="text-figma-text text-sm w-12 text-right">
            {Math.round(selectedObject.opacity * 100)}%
          </span>
        </div>
      </PropertySection>

      {/* Text properties */}
      {selectedObject.type === 'text' && (
        <>
          <PropertySection title="Text">
            <textarea
              value={selectedObject.text || ''}
              onChange={(e) => handleChange('text', e.target.value)}
              className="w-full bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none resize-none h-20"
            />
          </PropertySection>

          <PropertySection title="Font">
            <PropertyInput
              label="Size"
              value={selectedObject.fontSize || 16}
              onChange={(v) => handleChange('fontSize', v)}
              min={1}
              suffix="px"
            />
            <div className="mt-2">
              <select
                value={selectedObject.textAlign || 'left'}
                onChange={(e) => handleChange('textAlign', e.target.value)}
                className="w-full bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
            </div>
          </PropertySection>
        </>
      )}
    </div>
  );
}

/**
 * Section wrapper for grouping related properties.
 * @param props - Component props
 * @param props.title - Section header text
 * @param props.children - Property controls to display
 * @returns The rendered section element
 */
function PropertySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-figma-border">
      <h3 className="text-figma-text-secondary text-xs uppercase mb-2">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Numeric input with label and optional suffix.
 * Manages local state for smooth editing, commits on blur or Enter.
 * @param props - Component props
 * @param props.label - Short label displayed before the input
 * @param props.value - Current numeric value
 * @param props.onChange - Callback when value is committed
 * @param props.min - Optional minimum value
 * @param props.max - Optional maximum value
 * @param props.step - Step increment (default 1)
 * @param props.suffix - Optional unit suffix (e.g., "px", "deg")
 * @returns The rendered input element
 */
function PropertyInput({
  label,
  value,
  onChange,
  min: _min,
  max: _max,
  step: _step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [localValue, setLocalValue] = useState(value.toString());

  const handleBlur = () => {
    const parsed = parseFloat(localValue);
    if (!isNaN(parsed)) {
      onChange(parsed);
    } else {
      setLocalValue(value.toString());
    }
  };

  React.useEffect(() => {
    setLocalValue(Math.round(value * 100) / 100 + '');
  }, [value]);

  return (
    <div className="flex items-center gap-1">
      <span className="text-figma-text-secondary text-xs w-4">{label}</span>
      <input
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
        className="flex-1 bg-figma-bg border border-figma-border rounded px-2 py-1 text-figma-text text-sm focus:border-figma-accent outline-none"
      />
      {suffix && <span className="text-figma-text-secondary text-xs">{suffix}</span>}
    </div>
  );
}
