/**
 * Frontend unit tests for auth.js and Reactions gating.
 * Run with: npm test
 */

// ── Minimal DOM / browser shims ───────────────────────────────────────────────
const localStorageStore = {};
const localStorageMock = {
  getItem:  (k) => localStorageStore[k] ?? null,
  setItem:  (k, v) => { localStorageStore[k] = String(v); },
  removeItem: (k) => { delete localStorageStore[k]; },
  clear:    () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};
global.localStorage = localStorageMock;

global.crypto = {
  randomUUID: () => 'test-uuid-1234',
};

// Mock fetch globally
global.fetch = jest.fn();

// Mock DOM element used by showLoginModal
global.document = {
  getElementById: jest.fn(() => ({ hidden: false, focus: jest.fn() })),
};

const { Auth } = require('../auth.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockFetch(body, status = 200) {
  global.fetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

// ── Auth module tests ─────────────────────────────────────────────────────────
describe('Auth module', () => {
  let auth;

  beforeEach(() => {
    auth = new Auth();
    jest.clearAllMocks();
    localStorageMock.clear();
  });

  test('init(): sets loggedIn=false when server returns logged_in:false', async () => {
    mockFetch({ logged_in: false });
    await auth.init();
    expect(auth.getState().loggedIn).toBe(false);
    expect(auth.getState().username).toBeNull();
  });

  test('init(): sets loggedIn=true and username when server returns user', async () => {
    mockFetch({ logged_in: true, id: 1, username: 'alice' });
    await auth.init();
    expect(auth.getState().loggedIn).toBe(true);
    expect(auth.getState().username).toBe('alice');
    expect(auth.getState().userId).toBe(1);
  });

  test('init(): handles network error gracefully', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    await auth.init();
    expect(auth.getState().loggedIn).toBe(false);
  });

  test('login(): updates state on 200', async () => {
    mockFetch({ id: 2, username: 'bob' }, 200);
    await auth.login('bob', 'password123');
    expect(auth.getState().loggedIn).toBe(true);
    expect(auth.getState().username).toBe('bob');
  });

  test('login(): rejects on 401', async () => {
    mockFetch({ error: 'Invalid password' }, 401);
    await expect(auth.login('bob', 'wrongpass')).rejects.toThrow('Invalid password');
    expect(auth.getState().loggedIn).toBe(false);
  });

  test('login(): rejects on network error', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));
    await expect(auth.login('bob', 'pass')).rejects.toThrow('Network error');
  });

  test('register(): creates account and sets session state', async () => {
    mockFetch({ id: 3, username: 'charlie' }, 201);
    await auth.register('charlie', 'securepass');
    expect(auth.getState().loggedIn).toBe(true);
    expect(auth.getState().username).toBe('charlie');
  });

  test('register(): rejects with 409 on duplicate username', async () => {
    mockFetch({ error: 'Username already taken' }, 409);
    await expect(auth.register('alice', 'pass1234')).rejects.toMatchObject({ status: 409 });
  });

  test('logout(): clears state', async () => {
    mockFetch({ id: 1, username: 'alice' }, 200);
    await auth.login('alice', 'pass1234');

    mockFetch({ message: 'logged out' }, 200);
    await auth.logout();
    expect(auth.getState().loggedIn).toBe(false);
    expect(auth.getState().username).toBeNull();
  });

  test('getUserId(): returns numeric id string when logged in', async () => {
    mockFetch({ id: 5, username: 'dave' }, 200);
    await auth.login('dave', 'pass1234');
    expect(auth.getUserId()).toBe('5');
  });

  test('getUserId(): returns localStorage UUID when anonymous', () => {
    expect(auth.getUserId()).toBe('test-uuid-1234');
    expect(localStorageMock.getItem('rc_user_id')).toBe('test-uuid-1234');
  });

  test('getUserId(): reuses existing localStorage UUID when anonymous', () => {
    localStorageMock.setItem('rc_user_id', 'existing-uuid');
    expect(auth.getUserId()).toBe('existing-uuid');
  });

  test('onChange(): notifies all listeners on state change', async () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    auth.onChange(cb1);
    auth.onChange(cb2);

    mockFetch({ id: 1, username: 'alice' }, 200);
    await auth.login('alice', 'pass1234');

    expect(cb1).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: true, username: 'alice' }));
    expect(cb2).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: true, username: 'alice' }));
  });
});

// ── Reactions gating tests ────────────────────────────────────────────────────
const { Reactions } = require('../reactions.js');

function makeSocket() {
  const handlers = {};
  return {
    on:   (ev, fn) => { handlers[ev] = fn; },
    once: (ev, fn) => { handlers[`once_${ev}`] = fn; },
    off:  jest.fn(),
    emit: jest.fn(),
    _trigger: (ev, data) => { handlers[ev]?.(data); },
  };
}

describe('Reactions gating', () => {
  let socket, container, auth, reactions;

  beforeEach(() => {
    jest.clearAllMocks();

    socket = makeSocket();
    container = { appendChild: jest.fn(), querySelectorAll: jest.fn(() => []) };
    auth = new Auth();
  });

  function initReactions() {
    reactions = new Reactions({ socket, container, auth });
    // Stub _render and _fetchInitialState to avoid DOM ops
    reactions._render = jest.fn();
    reactions._fetchInitialState = jest.fn();
    reactions.init();
  }

  test('does NOT emit reaction_toggle if user is not logged in', () => {
    // auth starts logged out
    initReactions();
    reactions._handleClick('❤️');
    expect(socket.emit).not.toHaveBeenCalledWith('reaction_toggle', expect.anything());
  });

  test('calls showLoginModal when not logged in', () => {
    auth.showLoginModal = jest.fn();
    initReactions();
    reactions._handleClick('🔥');
    expect(auth.showLoginModal).toHaveBeenCalled();
  });

  test('emits reaction_toggle if logged in', async () => {
    mockFetch({ id: 1, username: 'alice' }, 200);
    await auth.login('alice', 'pass1234');

    initReactions();
    reactions._handleClick('❤️');
    expect(socket.emit).toHaveBeenCalledWith('reaction_toggle', { emoji: '❤️', user_id: '1' });
  });

  test('uses auth.getUserId() when logged in', async () => {
    mockFetch({ id: 42, username: 'testuser' }, 200);
    await auth.login('testuser', 'pass1234');

    initReactions();
    reactions._handleClick('🎵');
    expect(socket.emit).toHaveBeenCalledWith('reaction_toggle', expect.objectContaining({ user_id: '42' }));
  });
});
