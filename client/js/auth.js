const API_BASE = 'http://localhost:5000';

class Auth {
  constructor() {
    this._state = { loggedIn: false, userId: null, username: null };
    this._listeners = [];
  }

  async init() {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
      const data = await res.json();
      if (data.logged_in) {
        this._state = { loggedIn: true, userId: data.id, username: data.username };
      } else {
        this._state = { loggedIn: false, userId: null, username: null };
      }
    } catch (_) {
      this._state = { loggedIn: false, userId: null, username: null };
    }
    this._notify();
  }

  async login(username, password) {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Login failed'), { status: res.status });
    this._state = { loggedIn: true, userId: data.id, username: data.username };
    this._notify();
    return data;
  }

  async register(username, password) {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || 'Registration failed'), { status: res.status });
    this._state = { loggedIn: true, userId: data.id, username: data.username };
    this._notify();
    return data;
  }

  async logout() {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    this._state = { loggedIn: false, userId: null, username: null };
    this._notify();
  }

  getState() {
    return { ...this._state };
  }

  getUserId() {
    if (this._state.loggedIn) return String(this._state.userId);
    let id = localStorage.getItem('rc_user_id');
    if (!id) id = this._generateAnonymousId();
    return id;
  }

  showLoginModal() {
    const modal = document.getElementById('modal-login');
    if (modal) {
      modal.hidden = false;
      document.getElementById('login-username')?.focus();
    }
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  _notify() {
    this._listeners.forEach(fn => fn(this.getState()));
  }

  _generateAnonymousId() {
    let id;
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      id = crypto.randomUUID();
    } else {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    localStorage.setItem('rc_user_id', id);
    return id;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Auth };
}
