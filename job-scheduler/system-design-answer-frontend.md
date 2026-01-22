# Job Scheduler - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"Today I'll design the frontend for a distributed job scheduler dashboard, focusing on the UI components and user experience for managing jobs, monitoring executions, and viewing worker status. The key challenges are displaying real-time execution updates, building intuitive job configuration forms, and creating effective monitoring visualizations with appropriate loading and error states."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Job Management Dashboard** - List, create, edit, delete jobs
2. **Execution Monitoring** - Real-time status updates, execution history
3. **Worker Status** - Active workers, health metrics
4. **Dead Letter Queue** - Failed jobs inspection and retry
5. **Metrics Dashboard** - System health visualization

### UI/UX Requirements

- **Responsiveness**: Desktop-first but mobile-friendly
- **Real-time Updates**: WebSocket for live execution status
- **Accessibility**: WCAG 2.1 AA compliance
- **Performance**: Handle thousands of jobs with virtualization

### Frontend Deep Dive Areas

- Job list with filtering, sorting, and bulk actions
- Job configuration form with cron expression builder
- Execution timeline with status indicators
- Worker health monitoring cards

---

## Step 2: Component Architecture

### Application Structure

```
src/
├── routes/
│   ├── __root.tsx           # Root layout with navigation
│   ├── index.tsx            # Dashboard overview
│   ├── jobs/
│   │   ├── index.tsx        # Job list view
│   │   ├── new.tsx          # Create job form
│   │   └── $jobId.tsx       # Job detail view
│   ├── executions/
│   │   ├── index.tsx        # Execution list
│   │   └── $executionId.tsx # Execution detail
│   ├── workers.tsx          # Worker status
│   └── dead-letter.tsx      # Dead letter queue
├── components/
│   ├── jobs/
│   │   ├── JobList.tsx
│   │   ├── JobCard.tsx
│   │   ├── JobForm.tsx
│   │   └── CronBuilder.tsx
│   ├── executions/
│   │   ├── ExecutionTimeline.tsx
│   │   ├── ExecutionCard.tsx
│   │   └── ExecutionLogs.tsx
│   ├── workers/
│   │   ├── WorkerGrid.tsx
│   │   └── WorkerCard.tsx
│   ├── metrics/
│   │   ├── QueueDepthChart.tsx
│   │   ├── ThroughputChart.tsx
│   │   └── MetricCard.tsx
│   └── ui/
│       ├── StatusBadge.tsx
│       ├── PriorityIndicator.tsx
│       └── TimeAgo.tsx
└── stores/
    ├── jobStore.ts
    ├── executionStore.ts
    └── workerStore.ts
```

---

## Step 3: Job List Component

### JobList with Filtering and Actions

```tsx
// components/jobs/JobList.tsx
import { useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useJobStore } from '@/stores/jobStore';
import { JobCard } from './JobCard';
import { StatusFilter } from './StatusFilter';
import { PriorityFilter } from './PriorityFilter';
import { HandlerFilter } from './HandlerFilter';

interface JobListProps {
  className?: string;
}

export function JobList({ className }: JobListProps) {
  const { jobs, loading, error, fetchJobs, pauseJob, resumeJob, triggerJob } = useJobStore();
  const [filters, setFilters] = useState({
    status: [] as string[],
    priority: null as number | null,
    handler: null as string | null,
    search: '',
  });
  const [sortBy, setSortBy] = useState<'name' | 'nextRun' | 'priority'>('nextRun');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());

  const parentRef = useRef<HTMLDivElement>(null);

  // Filter and sort jobs
  const filteredJobs = useMemo(() => {
    let result = [...jobs];

    // Apply filters
    if (filters.status.length > 0) {
      result = result.filter(job => filters.status.includes(job.status));
    }
    if (filters.priority !== null) {
      result = result.filter(job => job.priority >= filters.priority!);
    }
    if (filters.handler) {
      result = result.filter(job => job.handler === filters.handler);
    }
    if (filters.search) {
      const search = filters.search.toLowerCase();
      result = result.filter(job =>
        job.name.toLowerCase().includes(search) ||
        job.description?.toLowerCase().includes(search)
      );
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'nextRun':
          comparison = new Date(a.nextRunTime).getTime() - new Date(b.nextRunTime).getTime();
          break;
        case 'priority':
          comparison = b.priority - a.priority;
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [jobs, filters, sortBy, sortOrder]);

  // Virtualization for performance
  const virtualizer = useVirtualizer({
    count: filteredJobs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  const handleBulkAction = async (action: 'pause' | 'resume' | 'trigger') => {
    const jobIds = Array.from(selectedJobs);
    for (const jobId of jobIds) {
      switch (action) {
        case 'pause':
          await pauseJob(jobId);
          break;
        case 'resume':
          await resumeJob(jobId);
          break;
        case 'trigger':
          await triggerJob(jobId);
          break;
      }
    }
    setSelectedJobs(new Set());
  };

  if (loading) {
    return <JobListSkeleton />;
  }

  if (error) {
    return (
      <ErrorState
        message="Failed to load jobs"
        onRetry={fetchJobs}
      />
    );
  }

  return (
    <div className={className}>
      {/* Filter Bar */}
      <div className="flex flex-wrap gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
        <SearchInput
          value={filters.search}
          onChange={(search) => setFilters(prev => ({ ...prev, search }))}
          placeholder="Search jobs..."
        />
        <StatusFilter
          selected={filters.status}
          onChange={(status) => setFilters(prev => ({ ...prev, status }))}
        />
        <PriorityFilter
          value={filters.priority}
          onChange={(priority) => setFilters(prev => ({ ...prev, priority }))}
        />
        <HandlerFilter
          value={filters.handler}
          onChange={(handler) => setFilters(prev => ({ ...prev, handler }))}
        />
        <SortDropdown
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSortByChange={setSortBy}
          onSortOrderChange={setSortOrder}
        />
      </div>

      {/* Bulk Actions */}
      {selectedJobs.size > 0 && (
        <div className="flex items-center gap-4 mb-4 p-3 bg-blue-50 rounded-lg">
          <span className="text-sm font-medium text-blue-800">
            {selectedJobs.size} job{selectedJobs.size > 1 ? 's' : ''} selected
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkAction('pause')}
            >
              Pause Selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkAction('trigger')}
            >
              Trigger Selected
            </Button>
          </div>
          <button
            className="ml-auto text-sm text-gray-500 hover:text-gray-700"
            onClick={() => setSelectedJobs(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Job List */}
      <div
        ref={parentRef}
        className="h-[calc(100vh-280px)] overflow-auto"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const job = filteredJobs[virtualItem.index];
            return (
              <div
                key={job.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <JobCard
                  job={job}
                  selected={selectedJobs.has(job.id)}
                  onSelect={(selected) => {
                    setSelectedJobs(prev => {
                      const next = new Set(prev);
                      if (selected) {
                        next.add(job.id);
                      } else {
                        next.delete(job.id);
                      }
                      return next;
                    });
                  }}
                  onPause={() => pauseJob(job.id)}
                  onResume={() => resumeJob(job.id)}
                  onTrigger={() => triggerJob(job.id)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {filteredJobs.length === 0 && (
        <EmptyState
          icon={CalendarIcon}
          title="No jobs found"
          description={filters.search ? 'Try adjusting your filters' : 'Create your first job to get started'}
          action={
            <Link to="/jobs/new">
              <Button>Create Job</Button>
            </Link>
          }
        />
      )}
    </div>
  );
}
```

### JobCard Component

```tsx
// components/jobs/JobCard.tsx
import { Link } from '@tanstack/react-router';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PriorityIndicator } from '@/components/ui/PriorityIndicator';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { DropdownMenu } from '@/components/ui/DropdownMenu';

interface JobCardProps {
  job: Job;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onTrigger: () => void;
}

export function JobCard({
  job,
  selected,
  onSelect,
  onPause,
  onResume,
  onTrigger,
}: JobCardProps) {
  return (
    <div
      className={`
        p-4 bg-white border rounded-lg mb-2 transition-all
        hover:shadow-md hover:border-gray-300
        ${selected ? 'ring-2 ring-blue-500 border-blue-500' : 'border-gray-200'}
      `}
    >
      <div className="flex items-start gap-4">
        {/* Selection Checkbox */}
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          aria-label={`Select ${job.name}`}
        />

        {/* Priority Indicator */}
        <PriorityIndicator priority={job.priority} />

        {/* Job Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link
              to="/jobs/$jobId"
              params={{ jobId: job.id }}
              className="font-medium text-gray-900 hover:text-blue-600 truncate"
            >
              {job.name}
            </Link>
            <StatusBadge status={job.status} />
          </div>

          {job.description && (
            <p className="mt-1 text-sm text-gray-500 truncate">
              {job.description}
            </p>
          )}

          <div className="mt-2 flex items-center gap-4 text-sm text-gray-500">
            <span className="flex items-center gap-1">
              <CodeIcon className="w-4 h-4" />
              {job.handler}
            </span>
            {job.schedule && (
              <span className="flex items-center gap-1">
                <ClockIcon className="w-4 h-4" />
                {formatCronExpression(job.schedule)}
              </span>
            )}
            {job.nextRunTime && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="w-4 h-4" />
                Next: <TimeAgo date={job.nextRunTime} />
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        <DropdownMenu>
          <DropdownMenu.Trigger asChild>
            <button
              className="p-2 rounded-md hover:bg-gray-100"
              aria-label="Job actions"
            >
              <MoreVerticalIcon className="w-5 h-5 text-gray-500" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            <DropdownMenu.Item onClick={onTrigger}>
              <PlayIcon className="w-4 h-4 mr-2" />
              Trigger Now
            </DropdownMenu.Item>
            {job.status === 'SCHEDULED' ? (
              <DropdownMenu.Item onClick={onPause}>
                <PauseIcon className="w-4 h-4 mr-2" />
                Pause
              </DropdownMenu.Item>
            ) : job.status === 'PAUSED' ? (
              <DropdownMenu.Item onClick={onResume}>
                <PlayIcon className="w-4 h-4 mr-2" />
                Resume
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Separator />
            <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
              <DropdownMenu.Item>
                <EyeIcon className="w-4 h-4 mr-2" />
                View Details
              </DropdownMenu.Item>
            </Link>
            <Link to="/jobs/$jobId/edit" params={{ jobId: job.id }}>
              <DropdownMenu.Item>
                <EditIcon className="w-4 h-4 mr-2" />
                Edit
              </DropdownMenu.Item>
            </Link>
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
    </div>
  );
}
```

---

## Step 4: Job Configuration Form

### JobForm with Cron Builder

```tsx
// components/jobs/JobForm.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CronBuilder } from './CronBuilder';

const jobSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().optional(),
  handler: z.string().min(1, 'Handler is required'),
  payload: z.string().optional().refine(
    (val) => {
      if (!val) return true;
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid JSON' }
  ),
  scheduleType: z.enum(['once', 'recurring', 'delayed']),
  schedule: z.string().optional(),
  runAt: z.string().optional(),
  delay: z.number().optional(),
  priority: z.number().min(0).max(100),
  maxRetries: z.number().min(0).max(10),
  timeoutMs: z.number().min(1000).max(3600000),
});

type JobFormData = z.infer<typeof jobSchema>;

interface JobFormProps {
  initialData?: Partial<JobFormData>;
  handlers: string[];
  onSubmit: (data: JobFormData) => Promise<void>;
  onCancel: () => void;
}

export function JobForm({ initialData, handlers, onSubmit, onCancel }: JobFormProps) {
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<JobFormData>({
    resolver: zodResolver(jobSchema),
    defaultValues: {
      scheduleType: 'once',
      priority: 50,
      maxRetries: 3,
      timeoutMs: 300000,
      ...initialData,
    },
  });

  const scheduleType = watch('scheduleType');
  const schedule = watch('schedule');

  const handleFormSubmit = async (data: JobFormData) => {
    setSubmitting(true);
    try {
      await onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* Basic Info */}
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold text-gray-900">
          Basic Information
        </legend>

        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">
            Job Name *
          </label>
          <input
            id="name"
            type="text"
            {...register('name')}
            className={`
              mt-1 block w-full rounded-md border-gray-300 shadow-sm
              focus:border-blue-500 focus:ring-blue-500
              ${errors.name ? 'border-red-500' : ''}
            `}
            placeholder="e.g., daily-report-generator"
          />
          {errors.name && (
            <p className="mt-1 text-sm text-red-600">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="description"
            rows={3}
            {...register('description')}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            placeholder="What does this job do?"
          />
        </div>

        <div>
          <label htmlFor="handler" className="block text-sm font-medium text-gray-700">
            Handler *
          </label>
          <select
            id="handler"
            {...register('handler')}
            className={`
              mt-1 block w-full rounded-md border-gray-300 shadow-sm
              focus:border-blue-500 focus:ring-blue-500
              ${errors.handler ? 'border-red-500' : ''}
            `}
          >
            <option value="">Select a handler...</option>
            {handlers.map((handler) => (
              <option key={handler} value={handler}>
                {handler}
              </option>
            ))}
          </select>
          {errors.handler && (
            <p className="mt-1 text-sm text-red-600">{errors.handler.message}</p>
          )}
        </div>

        <div>
          <label htmlFor="payload" className="block text-sm font-medium text-gray-700">
            Payload (JSON)
          </label>
          <textarea
            id="payload"
            rows={4}
            {...register('payload')}
            className={`
              mt-1 block w-full rounded-md border-gray-300 shadow-sm font-mono text-sm
              focus:border-blue-500 focus:ring-blue-500
              ${errors.payload ? 'border-red-500' : ''}
            `}
            placeholder='{"key": "value"}'
          />
          {errors.payload && (
            <p className="mt-1 text-sm text-red-600">{errors.payload.message}</p>
          )}
        </div>
      </fieldset>

      {/* Scheduling */}
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold text-gray-900">
          Scheduling
        </legend>

        <div className="flex gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="once"
              {...register('scheduleType')}
              className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Run once</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="recurring"
              {...register('scheduleType')}
              className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Recurring (cron)</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              value="delayed"
              {...register('scheduleType')}
              className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">Delayed</span>
          </label>
        </div>

        {scheduleType === 'recurring' && (
          <CronBuilder
            value={schedule || ''}
            onChange={(cron) => setValue('schedule', cron)}
          />
        )}

        {scheduleType === 'once' && (
          <div>
            <label htmlFor="runAt" className="block text-sm font-medium text-gray-700">
              Run At
            </label>
            <input
              id="runAt"
              type="datetime-local"
              {...register('runAt')}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>
        )}

        {scheduleType === 'delayed' && (
          <div>
            <label htmlFor="delay" className="block text-sm font-medium text-gray-700">
              Delay (seconds)
            </label>
            <input
              id="delay"
              type="number"
              {...register('delay', { valueAsNumber: true })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              min={1}
            />
          </div>
        )}
      </fieldset>

      {/* Advanced Options */}
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold text-gray-900">
          Advanced Options
        </legend>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label htmlFor="priority" className="block text-sm font-medium text-gray-700">
              Priority (0-100)
            </label>
            <input
              id="priority"
              type="range"
              min={0}
              max={100}
              {...register('priority', { valueAsNumber: true })}
              className="mt-2 w-full"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>Low</span>
              <span className="font-medium">{watch('priority')}</span>
              <span>High</span>
            </div>
          </div>

          <div>
            <label htmlFor="maxRetries" className="block text-sm font-medium text-gray-700">
              Max Retries
            </label>
            <input
              id="maxRetries"
              type="number"
              min={0}
              max={10}
              {...register('maxRetries', { valueAsNumber: true })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="timeoutMs" className="block text-sm font-medium text-gray-700">
              Timeout (seconds)
            </label>
            <input
              id="timeoutMs"
              type="number"
              min={1}
              max={3600}
              {...register('timeoutMs', {
                valueAsNumber: true,
                setValueAs: (v) => v * 1000,
              })}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>
        </div>
      </fieldset>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating...' : initialData ? 'Update Job' : 'Create Job'}
        </Button>
      </div>
    </form>
  );
}
```

### CronBuilder Component

```tsx
// components/jobs/CronBuilder.tsx
interface CronBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

export function CronBuilder({ value, onChange }: CronBuilderProps) {
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [simple, setSimple] = useState({
    frequency: 'daily',
    hour: 0,
    minute: 0,
    dayOfWeek: 1,
    dayOfMonth: 1,
  });

  // Parse cron to simple format
  useEffect(() => {
    if (value) {
      const parsed = parseCronToSimple(value);
      if (parsed) {
        setSimple(parsed);
        setMode('simple');
      } else {
        setMode('advanced');
      }
    }
  }, []);

  const buildCronFromSimple = () => {
    switch (simple.frequency) {
      case 'minutely':
        return '* * * * *';
      case 'hourly':
        return `${simple.minute} * * * *`;
      case 'daily':
        return `${simple.minute} ${simple.hour} * * *`;
      case 'weekly':
        return `${simple.minute} ${simple.hour} * * ${simple.dayOfWeek}`;
      case 'monthly':
        return `${simple.minute} ${simple.hour} ${simple.dayOfMonth} * *`;
      default:
        return '';
    }
  };

  const handleSimpleChange = (field: string, value: any) => {
    const updated = { ...simple, [field]: value };
    setSimple(updated);
    onChange(buildCronFromSimple());
  };

  return (
    <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
      <div className="flex gap-2">
        <button
          type="button"
          className={`px-3 py-1 text-sm rounded ${
            mode === 'simple'
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-700 border'
          }`}
          onClick={() => setMode('simple')}
        >
          Simple
        </button>
        <button
          type="button"
          className={`px-3 py-1 text-sm rounded ${
            mode === 'advanced'
              ? 'bg-blue-600 text-white'
              : 'bg-white text-gray-700 border'
          }`}
          onClick={() => setMode('advanced')}
        >
          Advanced
        </button>
      </div>

      {mode === 'simple' ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Frequency
            </label>
            <select
              value={simple.frequency}
              onChange={(e) => handleSimpleChange('frequency', e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            >
              <option value="minutely">Every minute</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
          </div>

          {simple.frequency !== 'minutely' && (
            <div className="flex gap-4">
              {['hourly', 'daily', 'weekly', 'monthly'].includes(simple.frequency) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Minute
                  </label>
                  <select
                    value={simple.minute}
                    onChange={(e) => handleSimpleChange('minute', parseInt(e.target.value))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                  >
                    {Array.from({ length: 60 }, (_, i) => (
                      <option key={i} value={i}>
                        :{i.toString().padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {['daily', 'weekly', 'monthly'].includes(simple.frequency) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Hour
                  </label>
                  <select
                    value={simple.hour}
                    onChange={(e) => handleSimpleChange('hour', parseInt(e.target.value))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {i.toString().padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {simple.frequency === 'weekly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Day of Week
                  </label>
                  <select
                    value={simple.dayOfWeek}
                    onChange={(e) => handleSimpleChange('dayOfWeek', parseInt(e.target.value))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                  >
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
                      <option key={i} value={i}>{day}</option>
                    ))}
                  </select>
                </div>
              )}

              {simple.frequency === 'monthly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Day of Month
                  </label>
                  <select
                    value={simple.dayOfMonth}
                    onChange={(e) => handleSimpleChange('dayOfMonth', parseInt(e.target.value))}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                  >
                    {Array.from({ length: 31 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <CronPreview cron={value} />
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Cron Expression
          </label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm font-mono"
            placeholder="* * * * *"
          />
          <p className="mt-1 text-xs text-gray-500">
            Format: minute hour day-of-month month day-of-week
          </p>
          <CronPreview cron={value} />
        </div>
      )}
    </div>
  );
}

function CronPreview({ cron }: { cron: string }) {
  const description = useMemo(() => {
    try {
      return cronstrue.toString(cron);
    } catch {
      return 'Invalid cron expression';
    }
  }, [cron]);

  const nextRuns = useMemo(() => {
    try {
      const interval = cronParser.parseExpression(cron);
      return Array.from({ length: 3 }, () => interval.next().toDate());
    } catch {
      return [];
    }
  }, [cron]);

  return (
    <div className="mt-3 p-3 bg-white rounded border">
      <p className="text-sm font-medium text-gray-900">{description}</p>
      {nextRuns.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-gray-500 mb-1">Next runs:</p>
          <ul className="text-xs text-gray-600 space-y-1">
            {nextRuns.map((date, i) => (
              <li key={i}>{formatDate(date)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

---

## Step 5: Execution Timeline

### ExecutionTimeline Component

```tsx
// components/executions/ExecutionTimeline.tsx
import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ExecutionCard } from './ExecutionCard';

interface ExecutionTimelineProps {
  jobId?: string;
  limit?: number;
}

export function ExecutionTimeline({ jobId, limit = 50 }: ExecutionTimelineProps) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch initial executions
  useEffect(() => {
    async function fetchExecutions() {
      setLoading(true);
      try {
        const url = jobId
          ? `/api/v1/jobs/${jobId}/executions?limit=${limit}`
          : `/api/v1/executions?limit=${limit}`;
        const response = await fetch(url);
        const data = await response.json();
        setExecutions(data.executions);
      } finally {
        setLoading(false);
      }
    }
    fetchExecutions();
  }, [jobId, limit]);

  // Subscribe to real-time updates
  useWebSocket({
    channel: jobId ? `job:${jobId}:executions` : 'executions',
    onMessage: (message) => {
      if (message.type === 'execution_started') {
        setExecutions(prev => [message.execution, ...prev]);
      } else if (message.type === 'execution_updated') {
        setExecutions(prev =>
          prev.map(e => e.id === message.execution.id ? message.execution : e)
        );
      }
    },
  });

  if (loading) {
    return <ExecutionTimelineSkeleton />;
  }

  if (executions.length === 0) {
    return (
      <EmptyState
        icon={ClockIcon}
        title="No executions yet"
        description="This job hasn't been executed yet"
      />
    );
  }

  return (
    <div ref={scrollRef} className="relative">
      {/* Timeline line */}
      <div className="absolute left-8 top-0 bottom-0 w-0.5 bg-gray-200" />

      {/* Execution items */}
      <div className="space-y-4">
        {executions.map((execution, index) => (
          <ExecutionCard
            key={execution.id}
            execution={execution}
            isFirst={index === 0}
            isLast={index === executions.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
```

### ExecutionCard Component

```tsx
// components/executions/ExecutionCard.tsx
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { ExecutionLogs } from './ExecutionLogs';

interface ExecutionCardProps {
  execution: Execution;
  isFirst: boolean;
  isLast: boolean;
}

export function ExecutionCard({ execution, isFirst, isLast }: ExecutionCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColors: Record<string, string> = {
    PENDING: 'bg-gray-400',
    RUNNING: 'bg-blue-500 animate-pulse',
    COMPLETED: 'bg-green-500',
    FAILED: 'bg-red-500',
    PENDING_RETRY: 'bg-yellow-500',
    CANCELLED: 'bg-gray-500',
    DEDUPLICATED: 'bg-purple-500',
  };

  const duration = execution.completedAt
    ? new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime()
    : execution.startedAt
      ? Date.now() - new Date(execution.startedAt).getTime()
      : null;

  return (
    <div className="relative pl-16">
      {/* Timeline dot */}
      <div
        className={`
          absolute left-6 w-4 h-4 rounded-full border-4 border-white
          ${statusColors[execution.status]}
        `}
      />

      {/* Card content */}
      <div
        className={`
          p-4 bg-white rounded-lg border
          ${execution.status === 'RUNNING' ? 'border-blue-300 shadow-md' : 'border-gray-200'}
        `}
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <StatusBadge status={execution.status} />
              <span className="text-sm text-gray-500">
                Attempt {execution.attempt}
              </span>
            </div>

            <div className="mt-1 text-sm text-gray-600">
              {execution.scheduledAt && (
                <span>
                  Scheduled <TimeAgo date={execution.scheduledAt} />
                </span>
              )}
              {execution.startedAt && (
                <span className="ml-3">
                  Started <TimeAgo date={execution.startedAt} />
                </span>
              )}
            </div>

            {duration !== null && (
              <div className="mt-1 text-sm text-gray-500">
                Duration: {formatDuration(duration)}
              </div>
            )}

            {execution.workerId && (
              <div className="mt-1 text-xs text-gray-400">
                Worker: {execution.workerId}
              </div>
            )}
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="text-sm text-blue-600 hover:text-blue-800"
            aria-expanded={expanded}
            aria-controls={`logs-${execution.id}`}
          >
            {expanded ? 'Hide logs' : 'Show logs'}
          </button>
        </div>

        {/* Error message */}
        {execution.error && (
          <div className="mt-3 p-2 bg-red-50 rounded text-sm text-red-700 font-mono">
            {execution.error}
          </div>
        )}

        {/* Result preview */}
        {execution.result && !execution.error && (
          <div className="mt-3 p-2 bg-green-50 rounded text-sm text-green-700 font-mono">
            <pre className="whitespace-pre-wrap">
              {JSON.stringify(execution.result, null, 2).slice(0, 200)}
              {JSON.stringify(execution.result).length > 200 && '...'}
            </pre>
          </div>
        )}

        {/* Expandable logs */}
        {expanded && (
          <div id={`logs-${execution.id}`} className="mt-4">
            <ExecutionLogs executionId={execution.id} />
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Step 6: Worker Status Dashboard

### WorkerGrid Component

```tsx
// components/workers/WorkerGrid.tsx
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { WorkerCard } from './WorkerCard';

export function WorkerGrid() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchWorkers() {
      setLoading(true);
      const response = await fetch('/api/v1/workers');
      const data = await response.json();
      setWorkers(data.workers);
      setLoading(false);
    }
    fetchWorkers();

    // Refresh every 5 seconds
    const interval = setInterval(fetchWorkers, 5000);
    return () => clearInterval(interval);
  }, []);

  // Real-time worker status updates
  useWebSocket({
    channel: 'workers',
    onMessage: (message) => {
      if (message.type === 'worker_updated') {
        setWorkers(prev =>
          prev.map(w => w.id === message.worker.id ? message.worker : w)
        );
      } else if (message.type === 'worker_joined') {
        setWorkers(prev => [...prev, message.worker]);
      } else if (message.type === 'worker_left') {
        setWorkers(prev => prev.filter(w => w.id !== message.workerId));
      }
    },
  });

  if (loading) {
    return <WorkerGridSkeleton />;
  }

  if (workers.length === 0) {
    return (
      <EmptyState
        icon={ServerIcon}
        title="No workers running"
        description="Start a worker to begin processing jobs"
      />
    );
  }

  // Summary stats
  const activeWorkers = workers.filter(w => w.status === 'active').length;
  const totalActiveJobs = workers.reduce((sum, w) => sum + w.activeJobs, 0);
  const totalCapacity = workers.reduce((sum, w) => sum + w.concurrency, 0);

  return (
    <div>
      {/* Summary bar */}
      <div className="mb-6 grid grid-cols-4 gap-4">
        <MetricCard
          label="Active Workers"
          value={activeWorkers}
          total={workers.length}
          icon={ServerIcon}
        />
        <MetricCard
          label="Jobs Processing"
          value={totalActiveJobs}
          total={totalCapacity}
          icon={CogIcon}
        />
        <MetricCard
          label="Total Capacity"
          value={totalCapacity}
          icon={ChartBarIcon}
        />
        <MetricCard
          label="Utilization"
          value={`${Math.round((totalActiveJobs / totalCapacity) * 100)}%`}
          icon={PercentIcon}
        />
      </div>

      {/* Worker cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workers.map((worker) => (
          <WorkerCard key={worker.id} worker={worker} />
        ))}
      </div>
    </div>
  );
}
```

### WorkerCard Component

```tsx
// components/workers/WorkerCard.tsx
interface WorkerCardProps {
  worker: Worker;
}

export function WorkerCard({ worker }: WorkerCardProps) {
  const isHealthy = worker.status === 'active' &&
    Date.now() - new Date(worker.lastHeartbeat).getTime() < 30000;

  const utilizationPercent = (worker.activeJobs / worker.concurrency) * 100;

  return (
    <div
      className={`
        p-4 bg-white rounded-lg border
        ${isHealthy ? 'border-gray-200' : 'border-red-300 bg-red-50'}
      `}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <div
            className={`
              w-3 h-3 rounded-full
              ${isHealthy ? 'bg-green-500' : 'bg-red-500'}
            `}
          />
          <h3 className="font-medium text-gray-900">{worker.id}</h3>
        </div>
        <span
          className={`
            px-2 py-0.5 text-xs rounded-full
            ${isHealthy
              ? 'bg-green-100 text-green-800'
              : 'bg-red-100 text-red-800'
            }
          `}
        >
          {isHealthy ? 'Healthy' : 'Unhealthy'}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {/* Active jobs progress */}
        <div>
          <div className="flex justify-between text-sm text-gray-600 mb-1">
            <span>Active Jobs</span>
            <span>{worker.activeJobs} / {worker.concurrency}</span>
          </div>
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`
                h-full transition-all duration-300
                ${utilizationPercent > 80 ? 'bg-red-500' :
                  utilizationPercent > 50 ? 'bg-yellow-500' : 'bg-green-500'}
              `}
              style={{ width: `${utilizationPercent}%` }}
            />
          </div>
        </div>

        {/* Worker stats */}
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-gray-500">Started:</span>
            <span className="ml-1 text-gray-900">
              <TimeAgo date={worker.startedAt} />
            </span>
          </div>
          <div>
            <span className="text-gray-500">Last heartbeat:</span>
            <span className="ml-1 text-gray-900">
              <TimeAgo date={worker.lastHeartbeat} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## Step 7: State Management

### Job Store with Zustand

```typescript
// stores/jobStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface Job {
  id: string;
  name: string;
  description?: string;
  handler: string;
  payload: any;
  schedule?: string;
  nextRunTime?: string;
  priority: number;
  status: 'SCHEDULED' | 'QUEUED' | 'RUNNING' | 'PAUSED';
}

interface JobState {
  jobs: Job[];
  loading: boolean;
  error: string | null;

  fetchJobs: () => Promise<void>;
  createJob: (data: Partial<Job>) => Promise<Job>;
  updateJob: (id: string, data: Partial<Job>) => Promise<Job>;
  deleteJob: (id: string) => Promise<void>;
  pauseJob: (id: string) => Promise<void>;
  resumeJob: (id: string) => Promise<void>;
  triggerJob: (id: string) => Promise<void>;
}

export const useJobStore = create<JobState>()(
  immer((set, get) => ({
    jobs: [],
    loading: false,
    error: null,

    fetchJobs: async () => {
      set({ loading: true, error: null });
      try {
        const response = await fetch('/api/v1/jobs');
        if (!response.ok) throw new Error('Failed to fetch jobs');
        const data = await response.json();
        set({ jobs: data.jobs, loading: false });
      } catch (error) {
        set({ error: error.message, loading: false });
      }
    },

    createJob: async (data) => {
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message);
      }

      const job = await response.json();
      set((state) => {
        state.jobs.unshift(job);
      });
      return job;
    },

    updateJob: async (id, data) => {
      const response = await fetch(`/api/v1/jobs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error('Failed to update job');
      }

      const updatedJob = await response.json();
      set((state) => {
        const index = state.jobs.findIndex(j => j.id === id);
        if (index !== -1) {
          state.jobs[index] = updatedJob;
        }
      });
      return updatedJob;
    },

    deleteJob: async (id) => {
      await fetch(`/api/v1/jobs/${id}`, { method: 'DELETE' });
      set((state) => {
        state.jobs = state.jobs.filter(j => j.id !== id);
      });
    },

    pauseJob: async (id) => {
      // Optimistic update
      set((state) => {
        const job = state.jobs.find(j => j.id === id);
        if (job) job.status = 'PAUSED';
      });

      try {
        await fetch(`/api/v1/jobs/${id}/pause`, { method: 'POST' });
      } catch {
        // Rollback on failure
        await get().fetchJobs();
      }
    },

    resumeJob: async (id) => {
      // Optimistic update
      set((state) => {
        const job = state.jobs.find(j => j.id === id);
        if (job) job.status = 'SCHEDULED';
      });

      try {
        await fetch(`/api/v1/jobs/${id}/resume`, { method: 'POST' });
      } catch {
        await get().fetchJobs();
      }
    },

    triggerJob: async (id) => {
      await fetch(`/api/v1/jobs/${id}/trigger`, { method: 'POST' });
      // Execution will appear via WebSocket
    },
  }))
);
```

---

## Step 8: UI Components

### StatusBadge Component

```tsx
// components/ui/StatusBadge.tsx
interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
  SCHEDULED: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Scheduled' },
  QUEUED: { bg: 'bg-purple-100', text: 'text-purple-800', label: 'Queued' },
  PENDING: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'Pending' },
  RUNNING: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Running' },
  COMPLETED: { bg: 'bg-green-100', text: 'text-green-800', label: 'Completed' },
  FAILED: { bg: 'bg-red-100', text: 'text-red-800', label: 'Failed' },
  PAUSED: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Paused' },
  PENDING_RETRY: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Retry Pending' },
  CANCELLED: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Cancelled' },
  DEDUPLICATED: { bg: 'bg-purple-100', text: 'text-purple-800', label: 'Deduplicated' },
};

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const config = statusConfig[status] || {
    bg: 'bg-gray-100',
    text: 'text-gray-800',
    label: status,
  };

  return (
    <span
      className={`
        inline-flex items-center rounded-full font-medium
        ${config.bg} ${config.text}
        ${size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-0.5 text-sm'}
      `}
    >
      {status === 'RUNNING' && (
        <span className="mr-1.5 h-2 w-2 rounded-full bg-current animate-pulse" />
      )}
      {config.label}
    </span>
  );
}
```

### PriorityIndicator Component

```tsx
// components/ui/PriorityIndicator.tsx
interface PriorityIndicatorProps {
  priority: number;
  showLabel?: boolean;
}

export function PriorityIndicator({ priority, showLabel = false }: PriorityIndicatorProps) {
  const level = priority >= 80 ? 'critical' : priority >= 60 ? 'high' : priority >= 40 ? 'normal' : 'low';

  const config = {
    critical: { color: 'text-red-600', bg: 'bg-red-100', label: 'Critical' },
    high: { color: 'text-orange-600', bg: 'bg-orange-100', label: 'High' },
    normal: { color: 'text-blue-600', bg: 'bg-blue-100', label: 'Normal' },
    low: { color: 'text-gray-600', bg: 'bg-gray-100', label: 'Low' },
  };

  return (
    <div
      className={`
        flex items-center justify-center w-8 h-8 rounded-full
        ${config[level].bg}
      `}
      title={`Priority: ${priority}`}
    >
      <span className={`text-xs font-bold ${config[level].color}`}>
        {priority}
      </span>
      {showLabel && (
        <span className={`ml-2 text-sm ${config[level].color}`}>
          {config[level].label}
        </span>
      )}
    </div>
  );
}
```

### TimeAgo Component

```tsx
// components/ui/TimeAgo.tsx
import { useState, useEffect } from 'react';

interface TimeAgoProps {
  date: string | Date;
  live?: boolean;
}

export function TimeAgo({ date, live = true }: TimeAgoProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!live) return;

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, [live]);

  const timestamp = new Date(date).getTime();
  const diff = now - timestamp;
  const isFuture = diff < 0;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let text: string;
  if (seconds < 60) {
    text = isFuture ? 'in a few seconds' : 'just now';
  } else if (minutes < 60) {
    text = isFuture ? `in ${minutes}m` : `${minutes}m ago`;
  } else if (hours < 24) {
    text = isFuture ? `in ${hours}h` : `${hours}h ago`;
  } else {
    text = isFuture ? `in ${days}d` : `${days}d ago`;
  }

  return (
    <time
      dateTime={new Date(date).toISOString()}
      title={new Date(date).toLocaleString()}
      className="text-gray-500"
    >
      {text}
    </time>
  );
}
```

---

## Step 9: WebSocket Integration

### useWebSocket Hook

```tsx
// hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';

interface UseWebSocketOptions {
  channel: string;
  onMessage: (message: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export function useWebSocket({
  channel,
  onMessage,
  onConnect,
  onDisconnect,
}: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      // Subscribe to channel
      ws.send(JSON.stringify({ type: 'subscribe', channel }));
      onConnect?.();
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.channel === channel) {
        onMessage(message.data);
      }
    };

    ws.onclose = () => {
      onDisconnect?.();
      // Reconnect after delay
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsRef.current = ws;
  }, [channel, onMessage, onConnect, onDisconnect]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send };
}
```

---

## Closing Summary

"I've designed a job scheduler frontend dashboard with:

1. **Job list** with filtering, sorting, bulk actions, and virtualization for performance
2. **Job configuration form** with intuitive cron expression builder and preview
3. **Execution timeline** with real-time status updates via WebSocket
4. **Worker monitoring dashboard** with health indicators and utilization metrics
5. **Reusable UI components** for status badges, priority indicators, and time displays
6. **Zustand state management** with optimistic updates for responsive UX

The key insight is balancing real-time updates with usability - WebSocket connections provide immediate feedback while the form validation and cron builder make job configuration intuitive. The virtualized list ensures smooth performance even with thousands of jobs."
