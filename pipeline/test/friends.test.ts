import { describe, it, expect, beforeAll } from 'vitest';
import { registerUser, authGet, authPost } from './helpers.js';

describe('Friends', () => {
  let alice: { cookie: string; player: any; playerName: string };
  let bob: { cookie: string; player: any; playerName: string };

  beforeAll(async () => {
    alice = await registerUser();
    bob = await registerUser();
  });

  it('each player has a unique 6-char friend code', () => {
    expect(alice.player.friendCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(bob.player.friendCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(alice.player.friendCode).not.toBe(bob.player.friendCode);
  });

  it('lists no friends initially', async () => {
    const { status, body } = await authGet('/api/friends', alice.cookie);
    expect(status).toBe(200);
    expect(body.friends).toHaveLength(0);
    expect(body.pending).toHaveLength(0);
    expect(body.sent).toHaveLength(0);
  });

  it('sends friend request by code', async () => {
    const { status, body } = await authPost('/api/friends/add', alice.cookie, {
      code: bob.player.friendCode,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('shows pending request correctly for both sides', async () => {
    // Alice sent → should appear in Alice's "sent" list
    const { body: aliceList } = await authGet('/api/friends', alice.cookie);
    expect(aliceList.sent).toHaveLength(1);
    expect(aliceList.sent[0].player_name).toBe(bob.playerName);

    // Bob received → should appear in Bob's "pending" list
    const { body: bobList } = await authGet('/api/friends', bob.cookie);
    expect(bobList.pending).toHaveLength(1);
    expect(bobList.pending[0].player_name).toBe(alice.playerName);
  });

  it('rejects duplicate friend request', async () => {
    const { status } = await authPost('/api/friends/add', alice.cookie, {
      code: bob.player.friendCode,
    });
    expect(status).toBe(400);
  });

  it('rejects adding self as friend', async () => {
    const { status } = await authPost('/api/friends/add', alice.cookie, {
      code: alice.player.friendCode,
    });
    expect(status).toBe(400);
  });

  it('rejects invalid friend code', async () => {
    const { status } = await authPost('/api/friends/add', alice.cookie, {
      code: 'ZZZZZZ',
    });
    expect(status).toBe(404);
  });

  it('accepts friend request', async () => {
    // Get Bob's pending list to find the friendship ID
    const { body: bobList } = await authGet('/api/friends', bob.cookie);
    const friendship = bobList.pending[0];
    expect(friendship).toBeTruthy();

    const { status, body } = await authPost('/api/friends/accept', bob.cookie, {
      friendshipId: friendship.friendship_id,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('shows accepted friendship for both players', async () => {
    const { body: aliceList } = await authGet('/api/friends', alice.cookie);
    const { body: bobList } = await authGet('/api/friends', bob.cookie);

    expect(aliceList.friends).toHaveLength(1);
    expect(aliceList.friends[0].player_name).toBe(bob.playerName);

    expect(bobList.friends).toHaveLength(1);
    expect(bobList.friends[0].player_name).toBe(alice.playerName);
  });

  it('removes friendship', async () => {
    const { body: aliceList } = await authGet('/api/friends', alice.cookie);
    const friend = aliceList.friends[0];

    const { status } = await authPost('/api/friends/remove', alice.cookie, {
      friendId: friend.id,
    });
    expect(status).toBe(200);

    // Both sides should now have empty friend lists
    const { body: aliceAfter } = await authGet('/api/friends', alice.cookie);
    const { body: bobAfter } = await authGet('/api/friends', bob.cookie);
    expect(aliceAfter.friends).toHaveLength(0);
    expect(bobAfter.friends).toHaveLength(0);
  });

  it('requires auth for friend endpoints', async () => {
    const { status: s1 } = await authGet('/api/friends', '');
    const { status: s2 } = await authPost('/api/friends/add', '', { code: 'ABC123' });
    expect(s1).toBe(401);
    expect(s2).toBe(401);
  });
});
