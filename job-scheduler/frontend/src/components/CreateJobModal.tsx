/**
 * Modal form for creating new jobs.
 * Collects job configuration including handler, schedule, and payload.
 * @module components/CreateJobModal
 */

import { useRef, useState } from 'react';
import { CreateJobInput, MisfirePolicy } from '../types';
import { Button, Input, TextArea, Select, Modal } from './UI';

/** Props for the CreateJobModal component */
interface CreateJobModalProps {
  /** Controls modal visibility */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /**
   * Async callback to create the job. It receives the same idempotency key for every
   * submission of an unchanged draft, so resubmitting after a timeout cannot create
   * the job twice.
   */
  onCreate: (input: CreateJobInput, idempotencyKey: string) => Promise<void>;
}

/** Available job handlers with display labels */
const HANDLERS = [
  { value: 'test.echo', label: 'Test Echo' },
  { value: 'test.delay', label: 'Test Delay' },
  { value: 'test.log', label: 'Test Log' },
  { value: 'http.webhook', label: 'HTTP Webhook' },
  { value: 'shell.command', label: 'Shell Command' },
  { value: 'system.cleanup', label: 'System Cleanup' },
];

/**
 * Form modal for job creation with validation.
 * Handles form state, JSON payload parsing, and error display.
 */
export function CreateJobModal({ isOpen, onClose, onCreate }: CreateJobModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [handler, setHandler] = useState('test.echo');
  const [payload, setPayload] = useState('{}');
  const [schedule, setSchedule] = useState('');
  const [priority, setPriority] = useState(50);
  const [maxRetries, setMaxRetries] = useState(3);
  const [misfirePolicy, setMisfirePolicy] = useState<MisfirePolicy>('fire_once');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** Key for the draft last submitted; reused only while the draft is unchanged. */
  const submission = useRef<{ draft: string; key: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let parsedPayload = {};
      if (payload.trim()) {
        parsedPayload = JSON.parse(payload);
      }

      const input: CreateJobInput = {
        name,
        description: description || undefined,
        handler,
        payload: parsedPayload,
        schedule: schedule || undefined,
        priority,
        max_retries: maxRetries,
        misfire_policy: schedule ? misfirePolicy : undefined,
      };
      const draft = JSON.stringify(input);
      if (submission.current?.draft !== draft) {
        submission.current = { draft, key: crypto.randomUUID() };
      }

      await onCreate(input, submission.current.key);

      // Reset form
      submission.current = null;
      setName('');
      setDescription('');
      setHandler('test.echo');
      setPayload('{}');
      setSchedule('');
      setPriority(50);
      setMaxRetries(3);
      setMisfirePolicy('fire_once');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create New Job">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
            {error}
          </div>
        )}

        <Input
          label="Job Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-job"
          required
        />

        <TextArea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this job do?"
          rows={2}
        />

        <Select
          label="Handler"
          value={handler}
          onChange={(e) => setHandler(e.target.value)}
          options={HANDLERS}
        />

        <TextArea
          label="Payload (JSON)"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder="{}"
          rows={3}
          className="font-mono"
        />

        <Input
          label="Schedule (Cron Expression, UTC)"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="*/5 * * * * (every 5 minutes)"
        />

        {schedule.trim() && (
          <Select
            label="If runs are missed (scheduler down longer than the grace window)"
            value={misfirePolicy}
            onChange={(e) => setMisfirePolicy(e.target.value as MisfirePolicy)}
            options={[
              { value: 'fire_once', label: 'Run once to catch up' },
              { value: 'skip', label: 'Skip the missed runs' },
            ]}
          />
        )}

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Priority (0-100)"
            type="number"
            min={0}
            max={100}
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value))}
          />

          <Input
            label="Max Retries"
            type="number"
            min={0}
            max={10}
            value={maxRetries}
            onChange={(e) => setMaxRetries(parseInt(e.target.value))}
          />
        </div>

        <div className="flex justify-end space-x-2 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading || !name}>
            {loading ? 'Creating...' : 'Create Job'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
