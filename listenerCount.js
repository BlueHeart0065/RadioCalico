const SOCKET_URL = 'http://localhost:5000';

class ListenerCount {
  constructor({ badge }) {
    this._badge   = badge;
    this._socket  = null;
    this._playing = false;
  }

  connect() {
    if (this._socket) return;
    this._socket = io(SOCKET_URL, { transports: ['websocket'], reconnection: true });

    this._socket.on('connect', () => {
      if (this._playing) this._socket.emit('start_listening');
    });

    this._socket.on('listener_count', ({ count }) => {
      this._badge.textContent = count === 1
        ? '1 listening'
        : `${count} listening`;
    });
  }

  startListening() {
    this._playing = true;
    this._socket?.emit('start_listening');
  }

  stopListening() {
    this._playing = false;
    this._socket?.emit('stop_listening');
  }

  disconnect() {
    this._socket?.disconnect();
    this._socket  = null;
    this._playing = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ListenerCount };
}
