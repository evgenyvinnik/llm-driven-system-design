import { useEffect, useState } from 'react';
import type { UserLite } from '../../types';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Input } from '../Input';
import { Avatar } from '../Avatar';
import { api } from '../../services/api';
import { cx } from '../../utils';
import { CloseIcon } from '../icons';

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}

const TYPES = [
  { value: 'home', label: 'Home', emoji: '🏠', color: 'green' },
  { value: 'trip', label: 'Trip', emoji: '✈️', color: 'blue' },
  { value: 'couple', label: 'Couple', emoji: '❤️', color: 'pink' },
  { value: 'other', label: 'Other', emoji: '👥', color: 'orange' },
];

/** Create a group: name, type (which sets the color), and initial members via search. */
export function CreateGroupModal({ open, onClose, onCreated }: CreateGroupModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState('home');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserLite[]>([]);
  const [members, setMembers] = useState<UserLite[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (query.trim().length < 1) {
      setResults([]);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.searchUsers(query.trim());
        if (active) setResults(r.filter((u) => !members.some((m) => m.id === u.id)));
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query, members]);

  const reset = () => {
    setName('');
    setType('home');
    setQuery('');
    setResults([]);
    setMembers([]);
    setError('');
  };

  const addMember = (u: UserLite) => {
    setMembers((m) => [...m, u]);
    setQuery('');
    setResults([]);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const color = TYPES.find((t) => t.value === type)?.color || 'green';
      const { id } = await api.createGroup({
        name: name.trim(),
        groupType: type,
        avatarColor: color,
        memberIds: members.map((m) => m.id),
      });
      reset();
      onCreated(id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create group');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a group"
      maxWidth="max-w-md"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting} disabled={!name.trim()} className="flex-1">
            Create group
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Input label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Roommates, Tahoe Trip…" autoFocus />

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-split-ink">Type</label>
          <div className="grid grid-cols-4 gap-2">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setType(t.value)}
                className={cx(
                  'flex flex-col items-center gap-1 rounded-xl border py-2.5 transition',
                  type === t.value ? 'border-split-green bg-split-green/10' : 'border-split-line hover:bg-split-bg'
                )}
              >
                <span className="text-xl">{t.emoji}</span>
                <span className="text-xs font-medium text-split-ink">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-split-ink">Add members</label>
          {members.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {members.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 bg-split-green/10 text-split-green-dark rounded-full pl-1 pr-2 py-1">
                  <Avatar src={m.avatar_url} name={m.name || m.username} size="xs" />
                  <span className="text-xs font-medium">{m.name || m.username}</span>
                  <button type="button" onClick={() => setMembers((list) => list.filter((x) => x.id !== m.id))}>
                    <CloseIcon className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or username…" />
          {results.length > 0 && (
            <div className="card divide-y divide-split-line mt-1 overflow-hidden">
              {results.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => addMember(u)}
                  className="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-split-bg text-left"
                >
                  <Avatar src={u.avatar_url} name={u.name || u.username} size="sm" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-split-ink truncate">{u.name || u.username}</p>
                    <p className="text-xs text-split-ink-soft">@{u.username}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-split-ink-soft">You're added automatically. Try searching “bob”, “carol”, “dave”, or “emma”.</p>
        </div>

        {error && <p className="text-split-owe-dark text-sm text-center">{error}</p>}
      </div>
    </Modal>
  );
}
