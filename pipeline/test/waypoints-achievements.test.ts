import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, authGet, authPost, authDelete } from './helpers.js';

describe('Waypoints', () => {
  let user: { cookie: string; player: any };
  let other: { cookie: string; player: any };

  beforeAll(async () => {
    user = await registerUser();
    other = await registerUser();
  });

  it('creates a waypoint', async () => {
    const { status, body } = await authPost('/api/waypoints', user.cookie, {
      name: 'Home Base',
      lat: 33.69,
      lng: -117.34,
      icon: 'house',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBeTypeOf('number');
  });

  it('creates waypoint with default icon', async () => {
    const { status, body } = await authPost('/api/waypoints', user.cookie, {
      name: 'Spawn',
      lat: 40.76,
      lng: -73.97,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('deletes own waypoint', async () => {
    const { body: created } = await authPost('/api/waypoints', user.cookie, {
      name: 'Temp',
      lat: 0,
      lng: 0,
    });
    const { status } = await authDelete(`/api/waypoints/${created.id}`, user.cookie);
    expect(status).toBe(200);
  });

  it('cannot delete another player\'s waypoint', async () => {
    const { body: created } = await authPost('/api/waypoints', user.cookie, {
      name: 'Mine',
      lat: 1,
      lng: 1,
    });
    const { status } = await authDelete(`/api/waypoints/${created.id}`, other.cookie);
    expect(status).toBe(403);
  });

  it('requires auth', async () => {
    const { status } = await authPost('/api/waypoints', '', {
      name: 'No Auth',
      lat: 0,
      lng: 0,
    });
    expect(status).toBe(401);
  });
});

describe('Achievements', () => {
  let user: { cookie: string; player: any };

  beforeAll(async () => {
    user = await registerUser();
  });

  it('unlocks an achievement and awards XP', async () => {
    const { status, body } = await authPost('/api/achievement', user.cookie, {
      key: 'first_map',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.unlocked).toBe(true);
    expect(body.xp).toBe(100);
  });

  it('does not award XP for duplicate achievements', async () => {
    const { status, body } = await authPost('/api/achievement', user.cookie, {
      key: 'first_map',
    });
    expect(status).toBe(200);
    expect(body.unlocked).toBe(false);
    expect(body.xp).toBe(100); // unchanged
  });

  it('XP accumulates across achievements', async () => {
    await authPost('/api/achievement', user.cookie, { key: 'explorer_10' });
    await authPost('/api/achievement', user.cookie, { key: 'explorer_25' });
    await authPost('/api/achievement', user.cookie, { key: 'explorer_50' });
    await authPost('/api/achievement', user.cookie, { key: 'waypoint_set' });

    // 5 unique achievements × 100 XP = 500 XP = level 2
    const { body } = await authGet('/api/me', user.cookie);
    expect(body.player.xp).toBe(500);
    expect(body.player.level).toBe(2);
  });

  it('requires auth', async () => {
    const { status } = await authPost('/api/achievement', '', { key: 'test' });
    expect(status).toBe(401);
  });
});
