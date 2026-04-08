/**
 * Test helpers for integration tests against the running server.
 * Server must be running on BASE_URL before tests execute.
 */

export const BASE_URL = 'http://localhost:3001';

/** Unique test user name — max 16 chars, alphanumeric only */
let testCounter = 0;
export function uniqueName(prefix = 't') {
  const rand = Math.random().toString(36).slice(2, 8);
  return (prefix + rand + (testCounter++)).slice(0, 16);
}

/** Register a new user, return { cookie, player } */
export async function registerUser(name?: string, password = 'testpass123') {
  const playerName = name || uniqueName();
  const res = await fetch(`${BASE_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, password }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
  const body = await res.json();
  const player = body.player || body;
  return { cookie, player, playerName, password, status: res.status };
}

/** Login an existing user, return { cookie, player } */
export async function loginUser(playerName: string, password: string) {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerName, password }),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] || '';
  const body = await res.json();
  const player = body.player || body;
  return { cookie, player, status: res.status };
}

/** Authenticated GET */
export async function authGet(path: string, cookie: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: cookie },
  });
  return { status: res.status, body: await res.json() };
}

/** Authenticated POST */
export async function authPost(path: string, cookie: string, data: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/** Authenticated DELETE */
export async function authDelete(path: string, cookie: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
