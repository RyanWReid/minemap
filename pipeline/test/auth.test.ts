import { describe, it, expect } from 'vitest';
import { BASE_URL, uniqueName, registerUser, loginUser, authGet, authPost } from './helpers.js';

describe('Auth: Registration', () => {
  it('registers a new player and returns session cookie', async () => {
    const { cookie, player, status } = await registerUser();
    expect(status).toBe(200);
    expect(cookie).toContain('mc_session=');
    expect(player.playerName).toBeTruthy();
    expect(player.id).toBeTypeOf('number');
    expect(player.friendCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(player.xp).toBe(0);
    expect(player.level).toBe(1);
  });

  it('rejects duplicate player names (case insensitive)', async () => {
    const name = uniqueName();
    await registerUser(name);
    const { status, player } = await registerUser(name);
    expect(status).toBe(409);
    expect(player.error).toBeTruthy();
  });

  it('rejects names shorter than 3 characters', async () => {
    const { status } = await registerUser('ab');
    expect(status).toBe(400);
  });

  it('rejects names longer than 16 characters', async () => {
    const { status } = await registerUser('a'.repeat(17));
    expect(status).toBe(400);
  });

  it('rejects names with special characters', async () => {
    const { status } = await registerUser('test user!');
    expect(status).toBe(400);
  });

  it('rejects passwords shorter than 4 characters', async () => {
    const { status } = await registerUser(uniqueName(), '123');
    expect(status).toBe(400);
  });
});

describe('Auth: Login', () => {
  it('logs in with correct credentials', async () => {
    const name = uniqueName();
    await registerUser(name, 'mypassword');
    const { status, cookie, player } = await loginUser(name, 'mypassword');
    expect(status).toBe(200);
    expect(cookie).toContain('mc_session=');
    expect(player.playerName).toBe(name);
  });

  it('rejects wrong password', async () => {
    const name = uniqueName();
    await registerUser(name, 'correct');
    const { status } = await loginUser(name, 'wrong');
    expect(status).toBe(401);
  });

  it('rejects nonexistent player', async () => {
    const { status } = await loginUser('nonexistent_xyz_999', 'whatever');
    expect(status).toBe(401);
  });
});

describe('Auth: Session', () => {
  it('/api/me returns player data with valid session', async () => {
    const { cookie, playerName } = await registerUser();
    const { status, body } = await authGet('/api/me', cookie);
    expect(status).toBe(200);
    expect(body.player.playerName).toBe(playerName);
  });

  it('/api/me returns null without session', async () => {
    const { status, body } = await authGet('/api/me', '');
    expect(status).toBe(200);
    expect(body.player).toBeNull();
  });

  it('logout clears session', async () => {
    const { cookie } = await registerUser();
    await authPost('/api/logout', cookie, {});
    const { body } = await authGet('/api/me', cookie);
    expect(body.player).toBeNull();
  });
});
