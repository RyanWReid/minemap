import { describe, it, expect, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { BASE_URL, registerUser, authPost, authGet } from './helpers.js';

const WS_URL = BASE_URL.replace('http', 'ws');

/** Open a WebSocket with auth cookie, wait for welcome message */
function connectWS(cookie: string): Promise<{ ws: WebSocket; welcome: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: cookie } });
    const timeout = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 5000);
    ws.on('message', (data) => {
      clearTimeout(timeout);
      const msg = JSON.parse(data.toString());
      if (msg.type === 'error') {
        ws.close();
        reject(new Error(msg.message));
        return;
      }
      resolve({ ws, welcome: msg });
    });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ws.on('close', () => { clearTimeout(timeout); reject(new Error('WS closed')); });
  });
}

/** Wait for next message of a given type */
function waitForMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('WebSocket', () => {
  let alice: { cookie: string; player: any; playerName: string };
  let bob: { cookie: string; player: any; playerName: string };

  beforeAll(async () => {
    alice = await registerUser();
    bob = await registerUser();

    // Make them friends (accepted)
    await authPost('/api/friends/add', alice.cookie, { code: bob.player.friendCode });

    // Get Bob's PENDING list to find the friendship ID and accept it
    const { body: friendData } = await authGet('/api/friends', bob.cookie);
    const friendship = friendData.pending?.find((f: any) => f.player_name === alice.playerName);
    if (friendship) {
      await authPost('/api/friends/accept', bob.cookie, { friendshipId: friendship.friendship_id });
    }
  });

  it('connects with valid session and receives welcome', async () => {
    const { ws, welcome } = await connectWS(alice.cookie);
    expect(welcome.type).toBe('welcome');
    expect(welcome.playerName).toBe(alice.playerName);
    ws.close();
  });

  it('rejects connection without session', async () => {
    await expect(connectWS('mc_session=invalid')).rejects.toThrow();
  });

  it('broadcasts location to friends', async () => {
    const { ws: aliceWS } = await connectWS(alice.cookie);
    const { ws: bobWS } = await connectWS(bob.cookie);

    // Small delay for connections to register
    await new Promise(r => setTimeout(r, 300));

    const bobMsg = waitForMessage(bobWS, 'friend_location');
    aliceWS.send(JSON.stringify({ type: 'location', lat: 33.69, lng: -117.34 }));

    const msg = await bobMsg;
    expect(msg.type).toBe('friend_location');
    expect(msg.playerName).toBe(alice.playerName);
    expect(msg.lat).toBe(33.69);
    expect(msg.lng).toBe(-117.34);

    aliceWS.close();
    bobWS.close();
  });

  it('relays chat messages to friends', async () => {
    const { ws: aliceWS } = await connectWS(alice.cookie);
    const { ws: bobWS } = await connectWS(bob.cookie);

    await new Promise(r => setTimeout(r, 300));

    const bobMsg = waitForMessage(bobWS, 'chat');
    aliceWS.send(JSON.stringify({ type: 'chat', content: 'Hello from tests!' }));

    const msg = await bobMsg;
    expect(msg.type).toBe('chat');
    expect(msg.playerName).toBe(alice.playerName);
    expect(msg.content).toBe('Hello from tests!');

    aliceWS.close();
    bobWS.close();
  });

  it('echoes chat back to sender with self flag', async () => {
    const { ws: aliceWS } = await connectWS(alice.cookie);

    await new Promise(r => setTimeout(r, 300));

    const selfMsg = waitForMessage(aliceWS, 'chat');
    aliceWS.send(JSON.stringify({ type: 'chat', content: 'Echo test' }));

    const msg = await selfMsg;
    expect(msg.self).toBe(true);
    expect(msg.content).toBe('Echo test');

    aliceWS.close();
  });

  it('notifies friends when player comes online', async () => {
    const { ws: bobWS } = await connectWS(bob.cookie);

    await new Promise(r => setTimeout(r, 300));

    const onlineMsg = waitForMessage(bobWS, 'friend_online');
    const { ws: aliceWS } = await connectWS(alice.cookie);

    const msg = await onlineMsg;
    expect(msg.type).toBe('friend_online');
    expect(msg.playerName).toBe(alice.playerName);

    aliceWS.close();
    bobWS.close();
  });

  it('notifies friends when player goes offline', async () => {
    const { ws: bobWS } = await connectWS(bob.cookie);
    const { ws: aliceWS } = await connectWS(alice.cookie);

    await new Promise(r => setTimeout(r, 300));

    const offlineMsg = waitForMessage(bobWS, 'friend_offline');
    aliceWS.close();

    const msg = await offlineMsg;
    expect(msg.type).toBe('friend_offline');
    expect(msg.playerName).toBe(alice.playerName);

    bobWS.close();
  });
});
