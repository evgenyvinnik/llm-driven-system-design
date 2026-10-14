import { describe, it, expect, vi } from 'vitest';

// Mock shared modules before importing the module under test
vi.mock('../models/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import { hasPermission, isUuid, resolveChain, resolvePermission } from './permissions.js';

describe('resolvePermission', () => {
  it('gives workspace admins full access regardless of grants', () => {
    expect(resolvePermission('admin', null)).toBe('full_access');
    expect(resolvePermission('admin', 'view')).toBe('full_access');
  });

  it('lets members edit by default and a grant override that in either direction', () => {
    expect(resolvePermission('member', null)).toBe('edit');
    expect(resolvePermission('member', 'view')).toBe('view');
    expect(resolvePermission('member', 'full_access')).toBe('full_access');
  });

  it('shows guests nothing unless something was shared with them', () => {
    expect(resolvePermission('guest', null)).toBe('none');
    expect(resolvePermission('guest', 'edit')).toBe('edit');
  });

  it('gives non-members nothing even with a stray grant', () => {
    expect(resolvePermission(null, 'full_access')).toBe('none');
  });
});

describe('resolveChain', () => {
  it('carries the nearest ancestor grant down the tree', () => {
    // Workspace root -> Engineering (shared: view) -> Runbooks -> On-call (shared: edit)
    expect(resolveChain('guest', [null, 'view', null, 'edit', null])).toEqual([
      'none',
      'view',
      'view',
      'edit',
      'edit',
    ]);
  });

  it('lets a deeper grant restrict a member', () => {
    expect(resolveChain('member', [null, 'view', null])).toEqual(['edit', 'view', 'view']);
  });
});

describe('hasPermission and isUuid', () => {
  it('ranks none < view < edit < full_access', () => {
    expect(hasPermission('edit', 'view')).toBe(true);
    expect(hasPermission('view', 'edit')).toBe(false);
    expect(hasPermission('full_access', 'full_access')).toBe(true);
    expect(hasPermission('none', 'view')).toBe(false);
  });

  it('rejects malformed ids before they reach PostgreSQL', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000002')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
