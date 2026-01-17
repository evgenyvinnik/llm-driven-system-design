/**
 * DrawingsTab component - Drawing gallery with filtering capabilities.
 * Displays a grid of drawings with filter controls for shape, date range,
 * and deleted status. Supports flag, delete, and restore actions.
 * @module routes/admin/components/DrawingsTab
 */

import { useState } from 'react'
import { DrawingCard } from '../../../components/DrawingCard'
import { getDrawings, type Drawing } from '../../../services/api'

/**
 * Filter state for the drawings gallery.
 */
export interface DrawingFilters {
  /** Filter by shape type */
  shape: string
  /** Filter by start date (ISO string) */
  startDate: string
  /** Filter by end date (ISO string) */
  endDate: string
  /** Whether to include soft-deleted drawings */
  includeDeleted: boolean
}

/**
 * Shape option for the filter dropdown.
 */
interface ShapeOption {
  name: string
  count: number
}

/**
 * Props for the DrawingsTab component.
 */
interface DrawingsTabProps {
  /** Array of drawings to display */
  drawings: Drawing[]
  /** Available shape options for filtering */
  shapeOptions: ShapeOption[]
  /** Callback to reload all data */
  onRefresh: () => void
  /** Callback when drawings are updated (after filter/flag/delete) */
  onDrawingsUpdate: (drawings: Drawing[]) => void
  /** Callback to flag/unflag a drawing */
  onFlagDrawing: (drawingId: string, flagged: boolean) => Promise<void>
  /** Callback to delete a drawing */
  onDeleteDrawing: (drawingId: string) => Promise<void>
  /** Callback to restore a deleted drawing */
  onRestoreDrawing: (drawingId: string) => Promise<void>
}

/**
 * Drawings gallery tab with filtering and action capabilities.
 * Provides controls to filter drawings by shape, date range, and deleted status.
 * Each drawing card supports flag, delete, and restore actions.
 *
 * @param props - Component props
 */
export function DrawingsTab({
  drawings,
  shapeOptions,
  onRefresh,
  onDrawingsUpdate,
  onFlagDrawing,
  onDeleteDrawing,
  onRestoreDrawing,
}: DrawingsTabProps) {
  const [filters, setFilters] = useState<DrawingFilters>({
    shape: '',
    startDate: '',
    endDate: '',
    includeDeleted: false,
  })

  /**
   * Loads drawings with current filter settings from the API.
   * Updates the parent component with the filtered results.
   */
  const loadFilteredDrawings = async () => {
    try {
      const data = await getDrawings(1, 20, {
        shape: filters.shape || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        includeDeleted: filters.includeDeleted,
      })
      onDrawingsUpdate(data.drawings)
    } catch (err) {
      console.error('Failed to load drawings:', err)
    }
  }

  /**
   * Resets all filters to default values and reloads data.
   */
  const clearFilters = () => {
    setFilters({
      shape: '',
      startDate: '',
      endDate: '',
      includeDeleted: false,
    })
    onRefresh()
  }

  /**
   * Updates a single filter field.
   *
   * @param field - The filter field to update
   * @param value - The new value
   */
  const updateFilter = <K extends keyof DrawingFilters>(
    field: K,
    value: DrawingFilters[K]
  ) => {
    setFilters((f) => ({ ...f, [field]: value }))
  }

  return (
    <div className="drawings-section">
      <div className="drawings-header">
        <h2>Drawings</h2>
        <button onClick={onRefresh} className="refresh-btn">
          Refresh
        </button>
      </div>

      <DrawingsFilterBar
        filters={filters}
        shapeOptions={shapeOptions}
        onFilterChange={updateFilter}
        onApply={loadFilteredDrawings}
        onClear={clearFilters}
      />

      <div className="drawings-grid">
        {drawings.map((drawing) => (
          <DrawingCard
            key={drawing.id}
            id={drawing.id}
            shape={drawing.shape}
            createdAt={drawing.created_at}
            isFlagged={drawing.is_flagged}
            isDeleted={!!drawing.deleted_at}
            onFlag={onFlagDrawing}
            onDelete={onDeleteDrawing}
            onRestore={onRestoreDrawing}
          />
        ))}
        {drawings.length === 0 && (
          <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#94a3b8' }}>
            No drawings found
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Props for the DrawingsFilterBar component.
 */
interface DrawingsFilterBarProps {
  /** Current filter values */
  filters: DrawingFilters
  /** Available shape options */
  shapeOptions: ShapeOption[]
  /** Callback when a filter value changes */
  onFilterChange: <K extends keyof DrawingFilters>(
    field: K,
    value: DrawingFilters[K]
  ) => void
  /** Callback to apply filters */
  onApply: () => void
  /** Callback to clear all filters */
  onClear: () => void
}

/**
 * Filter bar with controls for shape, date range, and deleted status.
 *
 * @param props - Component props
 */
function DrawingsFilterBar({
  filters,
  shapeOptions,
  onFilterChange,
  onApply,
  onClear,
}: DrawingsFilterBarProps) {
  return (
    <div className="drawings-filters">
      <div className="filter-group">
        <label>Shape</label>
        <select
          value={filters.shape}
          onChange={(e) => onFilterChange('shape', e.target.value)}
        >
          <option value="">All Shapes</option>
          {shapeOptions.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label>Start Date</label>
        <input
          type="date"
          value={filters.startDate}
          onChange={(e) => onFilterChange('startDate', e.target.value)}
        />
      </div>

      <div className="filter-group">
        <label>End Date</label>
        <input
          type="date"
          value={filters.endDate}
          onChange={(e) => onFilterChange('endDate', e.target.value)}
        />
      </div>

      <div className="filter-group">
        <label>
          <input
            type="checkbox"
            checked={filters.includeDeleted}
            onChange={(e) => onFilterChange('includeDeleted', e.target.checked)}
          />
          {' '}Include Deleted
        </label>
      </div>

      <div className="filter-actions">
        <button className="apply-filter-btn" onClick={onApply}>
          Apply
        </button>
        <button className="clear-filter-btn" onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  )
}
