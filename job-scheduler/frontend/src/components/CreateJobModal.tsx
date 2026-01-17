import { useState } from 'react';
import { CreateJobInput } from '../types';
import { Button, Input, TextArea, Select, Modal } from './UI';

interface CreateJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateJobInput) => Promise<void>;
}

const HANDLERS = [
  { value: 'test.echo', label: 'Test Echo' },
  { value: 'test.delay', label: 'Test Delay' },
  { value: 'test.log', label: 'Test Log' },
  { value: 'http.webhook', label: 'HTTP Webhook' },
  { value: 'shell.command', label: 'Shell Command' },
  { value: 'system.cleanup', label: 'System Cleanup' },
];

export function CreateJobModal({ isOpen, onClose, onCreate }: CreateJobModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [handler, setHandler] = useState('test.echo');
  const [payload, setPayload] = useState('{}');
  const [schedule, setSchedule] = useState('');
  const [priority, setPriority] = useState(50);
  const [maxRetries, setMaxRetries] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let parsedPayload = {};
      if (payload.trim()) {
        parsedPayload = JSON.parse(payload);
      }

      await onCreate({
        name,
        description: description || undefined,
        handler,
        payload: parsedPayload,
        schedule: schedule || undefined,
        priority,
        max_retries: maxRetries,
      });

      // Reset form
      setName('');
      setDescription('');
      setHandler('test.echo');
      setPayload('{}');
      setSchedule('');
      setPriority(50);
      setMaxRetries(3);
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
          <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
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
          label="Schedule (Cron Expression)"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="*/5 * * * * (every 5 minutes)"
        />

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
