import eventlet
eventlet.monkey_patch()

import os
import re
import sqlite3
from collections import defaultdict
from flask import Flask, jsonify, request, g, session
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'dev-secret-change-in-prod')
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
app.config['SESSION_COOKIE_HTTPONLY'] = True

CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000"], supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins=[
    "http://localhost:3000", "http://127.0.0.1:3000"
], async_mode='eventlet', manage_session=True)

DATABASE = "radiocalico.db"
ALLOWED_EMOJIS = {"❤️", "🔥", "🎵", "👍", "😍", "✨"}

USERNAME_RE = re.compile(r'^[a-zA-Z0-9_]{3,30}$')

# ── In-memory listener state ───────────────────────────────────────────────────
_listeners      = set()              # sids currently playing
_ip_connections = defaultdict(int)   # ip → open socket count
MAX_CONNS_PER_IP = 10

# sid → listening_history row id (for logged-in users)
_listening_sessions = {}

# ── DB helpers ─────────────────────────────────────────────────────────────────
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DATABASE)
    db.execute("""
        CREATE TABLE IF NOT EXISTS example (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS reactions (
            emoji    TEXT NOT NULL,
            user_id  TEXT NOT NULL,
            PRIMARY KEY (emoji, user_id)
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS listening_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            track_title  TEXT,
            track_artist TEXT,
            started_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
            ended_at     DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    db.commit()
    db.close()


def _get_reaction_counts(db):
    rows = db.execute("SELECT emoji, COUNT(*) as cnt FROM reactions GROUP BY emoji").fetchall()
    counts = {e: 0 for e in ALLOWED_EMOJIS}
    for row in rows:
        if row[0] in ALLOWED_EMOJIS:
            counts[row[0]] = row[1]
    return counts


def _get_user_reactions(db, user_id):
    rows = db.execute("SELECT emoji FROM reactions WHERE user_id = ?", (user_id,)).fetchall()
    return [row[0] for row in rows if row[0] in ALLOWED_EMOJIS]


# ── REST ───────────────────────────────────────────────────────────────────────
@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/listeners")
def listeners():
    return jsonify({"count": len(_listeners)})


# ── Auth routes ────────────────────────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not USERNAME_RE.match(username):
        return jsonify({"error": "Username must be 3-30 alphanumeric characters or underscores"}), 400
    if not (8 <= len(password) <= 128):
        return jsonify({"error": "Password must be 8-128 characters"}), 400

    db = get_db()
    existing = db.execute(
        "SELECT id FROM users WHERE username = ? COLLATE NOCASE", (username,)
    ).fetchone()
    if existing:
        return jsonify({"error": "Username already taken"}), 409

    password_hash = generate_password_hash(password)
    cur = db.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)", (username, password_hash)
    )
    db.commit()
    user_id = cur.lastrowid

    session['user_id'] = user_id
    session['username'] = username
    return jsonify({"id": user_id, "username": username}), 201


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    db = get_db()
    user = db.execute(
        "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE", (username,)
    ).fetchone()
    if not user:
        return jsonify({"error": "User not found"}), 404

    if not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid password"}), 401

    session['user_id'] = user["id"]
    session['username'] = user["username"]
    return jsonify({"id": user["id"], "username": user["username"]}), 200


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"message": "logged out"}), 200


@app.route("/api/auth/me")
def auth_me():
    user_id = session.get('user_id')
    if user_id:
        return jsonify({"id": user_id, "username": session.get('username'), "logged_in": True}), 200
    return jsonify({"logged_in": False}), 200


@app.route("/api/me/history")
def me_history():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({"error": "Login required"}), 401
    db = get_db()
    rows = db.execute(
        """SELECT track_title, track_artist, started_at, ended_at
           FROM listening_history
           WHERE user_id = ?
           ORDER BY started_at DESC
           LIMIT 50""",
        (user_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows]), 200


# ── Socket.IO events ──────────────────────────────────────────────────────────
@socketio.on('connect')
def on_connect():
    ip = request.remote_addr
    if _ip_connections[ip] >= MAX_CONNS_PER_IP:
        return False
    _ip_connections[ip] += 1


@socketio.on('disconnect')
def on_disconnect():
    ip = request.remote_addr
    _ip_connections[ip] = max(0, _ip_connections[ip] - 1)
    if request.sid in _listeners:
        _listeners.discard(request.sid)
        socketio.emit('listener_count', {'count': len(_listeners)})
    # Close any open listening history row
    hist_id = _listening_sessions.pop(request.sid, None)
    if hist_id:
        try:
            db = sqlite3.connect(DATABASE)
            db.execute(
                "UPDATE listening_history SET ended_at = CURRENT_TIMESTAMP WHERE id = ?",
                (hist_id,)
            )
            db.commit()
            db.close()
        except Exception:
            pass


@socketio.on('start_listening')
def on_start():
    _listeners.add(request.sid)
    socketio.emit('listener_count', {'count': len(_listeners)})
    # Record listening history for logged-in users
    user_id = session.get('user_id')
    if user_id:
        try:
            db = sqlite3.connect(DATABASE)
            cur = db.execute(
                "INSERT INTO listening_history (user_id) VALUES (?)", (user_id,)
            )
            db.commit()
            _listening_sessions[request.sid] = cur.lastrowid
            db.close()
        except Exception:
            pass


@socketio.on('stop_listening')
def on_stop():
    _listeners.discard(request.sid)
    socketio.emit('listener_count', {'count': len(_listeners)})
    hist_id = _listening_sessions.pop(request.sid, None)
    if hist_id:
        try:
            db = sqlite3.connect(DATABASE)
            db.execute(
                "UPDATE listening_history SET ended_at = CURRENT_TIMESTAMP WHERE id = ?",
                (hist_id,)
            )
            db.commit()
            db.close()
        except Exception:
            pass


@socketio.on('reaction_fetch')
def on_reaction_fetch(data):
    user_id = (data or {}).get('user_id', '')
    if not user_id or len(user_id) > 64:
        return
    db = sqlite3.connect(DATABASE)
    try:
        counts = _get_reaction_counts(db)
        user_reactions = _get_user_reactions(db, user_id)
    finally:
        db.close()
    emit('reaction_state', {'counts': counts, 'user_reactions': user_reactions})


@app.route("/api/reactions/toggle", methods=["POST"])
def reaction_toggle():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({"error": "login_required"}), 401

    data = request.get_json(silent=True) or {}
    emoji = data.get('emoji', '')
    if emoji not in ALLOWED_EMOJIS:
        return jsonify({"error": "invalid_emoji"}), 400

    db = get_db()
    existing = db.execute(
        "SELECT 1 FROM reactions WHERE emoji = ? AND user_id = ?", (emoji, str(user_id))
    ).fetchone()
    if existing:
        db.execute("DELETE FROM reactions WHERE emoji = ? AND user_id = ?", (emoji, str(user_id)))
    else:
        db.execute("INSERT OR IGNORE INTO reactions (emoji, user_id) VALUES (?, ?)", (emoji, str(user_id)))
    db.commit()
    counts = _get_reaction_counts(db)
    socketio.emit('reaction_update', {'counts': counts})
    return jsonify({"counts": counts}), 200


@socketio.on('reaction_toggle')
def on_reaction_toggle(data):
    # Kept for backwards compatibility but no longer used by the client
    pass


if __name__ == "__main__":
    init_db()
    print("Database ready. Server running at http://localhost:5000")
    socketio.run(app, debug=True, port=5000)
