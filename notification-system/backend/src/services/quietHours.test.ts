import { describe, it, expect } from 'vitest';
import {
  isValidTimeZone,
  localMinutes,
  isWithinQuietHours,
  nextQuietHoursEnd,
  deliveryTimeAfterQuietHours,
} from './quietHours.js';

const night = (timezone: string) => ({ quietHoursStart: 22 * 60, quietHoursEnd: 7 * 60, timezone });

describe('quiet hours in the recipient time zone', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('reads the local clock of the zone, not the server', () => {
    const at = new Date('2026-06-01T03:30:00Z');
    expect(localMinutes(at, 'UTC')).toBe(3 * 60 + 30);
    expect(localMinutes(at, 'America/Los_Angeles')).toBe(20 * 60 + 30); // 20:30 PDT
    expect(localMinutes(at, 'Asia/Tokyo')).toBe(12 * 60 + 30);
  });

  it('handles windows that span midnight and same-day windows', () => {
    const at = new Date('2026-06-01T05:00:00Z'); // 22:00 in Los Angeles, 14:00 in Tokyo
    expect(isWithinQuietHours(night('America/Los_Angeles'), at)).toBe(true);
    expect(isWithinQuietHours(night('Asia/Tokyo'), at)).toBe(false);
    const lunch = { quietHoursStart: 12 * 60, quietHoursEnd: 13 * 60, timezone: 'UTC' };
    expect(isWithinQuietHours(lunch, new Date('2026-06-01T12:59:00Z'))).toBe(true);
    expect(isWithinQuietHours(lunch, new Date('2026-06-01T13:00:00Z'))).toBe(false);
  });

  it('treats a disabled or empty window as no quiet hours', () => {
    const at = new Date('2026-06-01T23:00:00Z');
    expect(isWithinQuietHours({ quietHoursStart: null, quietHoursEnd: null, timezone: 'UTC' }, at)).toBe(false);
    expect(isWithinQuietHours({ quietHoursStart: 600, quietHoursEnd: 600, timezone: 'UTC' }, at)).toBe(false);
  });

  it('defers to 07:00 local, the next morning', () => {
    const end = nextQuietHoursEnd(night('Europe/Berlin'), new Date('2026-06-01T21:15:42Z')); // 23:15 CEST
    expect(end.toISOString()).toBe('2026-06-02T05:00:00.000Z'); // 07:00 CEST
  });

  it('lands on 07:00 local across spring-forward and fall-back', () => {
    // 01:30 EST on 2026-03-08; clocks jump to 03:00 at 02:00, so 07:00 is EDT (UTC-4)
    expect(nextQuietHoursEnd(night('America/New_York'), new Date('2026-03-08T06:30:00Z')).toISOString())
      .toBe('2026-03-08T11:00:00.000Z');
    // 00:30 EDT on 2026-11-01; clocks fall back at 02:00, so 07:00 is EST (UTC-5)
    expect(nextQuietHoursEnd(night('America/New_York'), new Date('2026-11-01T04:30:00Z')).toISOString())
      .toBe('2026-11-01T12:00:00.000Z');
  });

  it('never defers critical notifications', () => {
    const at = new Date('2026-06-01T23:30:00Z');
    expect(deliveryTimeAfterQuietHours(night('UTC'), at, 'critical')).toEqual({ deliverAt: at, deferred: false });
    const normal = deliveryTimeAfterQuietHours(night('UTC'), at, 'normal');
    expect(normal.deferred).toBe(true);
    expect(normal.deliverAt.toISOString()).toBe('2026-06-02T07:00:00.000Z');
  });
});
