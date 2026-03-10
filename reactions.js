const REACTION_EMOJIS = ['❤️', '🔥', '🎵', '👍', '😍', '✨'];

class Reactions {
  constructor({ socket, container, auth }) {
    this._socket    = socket;
    this._container = container;
    this._auth      = auth || null;
    this._counts    = Object.fromEntries(REACTION_EMOJIS.map(e => [e, 0]));
    this._userReactions = new Set();
    this._pending   = new Set();
    this._debounceTimers = {};
  }

  _getUserId() {
    if (this._auth) return this._auth.getUserId();
    // Fallback: anonymous UUID from localStorage
    let id = localStorage.getItem('rc_user_id');
    if (!id) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }
      localStorage.setItem('rc_user_id', id);
    }
    return id;
  }

  init() {
    this._render();
    this._bindSocket();
    this._fetchInitialState();
  }

  _render() {
    const panel = document.createElement('div');
    panel.className = 'reaction-buttons';

    for (const emoji of REACTION_EMOJIS) {
      const btn = document.createElement('button');
      btn.className = 'reaction-btn';
      btn.dataset.emoji = emoji;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', `React with ${emoji}`);
      btn.innerHTML = `<span class="reaction-emoji">${emoji}</span><span class="reaction-count"></span>`;

      btn.addEventListener('click', () => {
        clearTimeout(this._debounceTimers[emoji]);
        this._debounceTimers[emoji] = setTimeout(() => this._handleClick(emoji), 300);
      });

      panel.appendChild(btn);
    }

    this._container.appendChild(panel);
  }

  _bindSocket() {
    this._socket.on('reaction_state', ({ counts, user_reactions }) => {
      this._counts = { ...this._counts, ...counts };
      this._userReactions = new Set(user_reactions);
      this._pending.clear();
      this._updateDOM();
    });

    this._socket.on('reaction_update', ({ counts }) => {
      this._counts = { ...this._counts, ...counts };
      this._pending.clear();
      this._updateDOM();
    });

    this._socket.on('reaction_error', ({ error }) => {
      if (error === 'login_required' && this._auth) {
        this._auth.showLoginModal();
      }
    });

    this._socket.on('connect', () => {
      this._fetchInitialState();
    });
  }

  _fetchInitialState() {
    this._socket.emit('reaction_fetch', { user_id: this._getUserId() });
  }

  _handleClick(emoji) {
    // Gate behind login
    if (this._auth && !this._auth.getState().loggedIn) {
      this._auth.showLoginModal();
      return;
    }

    if (this._pending.has(emoji)) return;

    const snapshot = {
      counts:       { ...this._counts },
      userReactions: new Set(this._userReactions),
    };

    this._pending.add(emoji);
    this._applyOptimisticUpdate(emoji);
    this._socket.emit('reaction_toggle', { emoji, user_id: this._getUserId() });

    const timeout = setTimeout(() => {
      if (this._pending.has(emoji)) {
        this._revertOptimisticUpdate(emoji, snapshot);
        this._pending.delete(emoji);
        this._updateDOM();
      }
    }, 3000);

    // Clear timeout when server confirms via reaction_update
    const cleanup = () => {
      clearTimeout(timeout);
      this._socket.off('reaction_update', cleanup);
    };
    this._socket.once('reaction_update', cleanup);
  }

  _applyOptimisticUpdate(emoji) {
    if (this._userReactions.has(emoji)) {
      this._userReactions.delete(emoji);
      this._counts[emoji] = Math.max(0, (this._counts[emoji] || 0) - 1);
    } else {
      this._userReactions.add(emoji);
      this._counts[emoji] = (this._counts[emoji] || 0) + 1;
    }
    this._updateDOM();
  }

  _revertOptimisticUpdate(emoji, snapshot) {
    this._counts = snapshot.counts;
    this._userReactions = snapshot.userReactions;
  }

  _updateDOM() {
    const btns = this._container.querySelectorAll('.reaction-btn');
    for (const btn of btns) {
      const emoji   = btn.dataset.emoji;
      const count   = this._counts[emoji] || 0;
      const active  = this._userReactions.has(emoji);
      const pending = this._pending.has(emoji);

      btn.classList.toggle('reaction-btn--active',  active);
      btn.classList.toggle('reaction-btn--pending', pending);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');

      const countEl = btn.querySelector('.reaction-count');
      countEl.textContent = count > 0 ? count : '';
      countEl.style.color = active ? 'var(--accent)' : '';
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Reactions };
}
