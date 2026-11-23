"""SQLite database for AI WeightLoss users (login/password/phone/email).

Passwords are never stored in plain text — PBKDF2-HMAC-SHA256 with a random salt.
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime

DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(__file__))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "users.db")
_PBKDF2_ROUNDS = 210_000


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                login TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                name TEXT,
                telegram_id INTEGER,
                ref_by TEXT,
                created_at TEXT NOT NULL,
                last_login TEXT
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_users_login ON users(login)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)")


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS).hex()


def create_user(login, password, phone, email="", name="", telegram_id=None, ref_by=None):
    """Return (ok, result). result is user id or error message."""
    login = (login or "").strip()
    if not login or not password or not phone:
        return False, "Логин, пароль и телефон обязательны"
    salt = secrets.token_bytes(16)
    pwd_hash = _hash_password(password, salt)
    try:
        with _conn() as c:
            cur = c.execute(
                """INSERT INTO users (login,password_hash,salt,phone,email,name,telegram_id,ref_by,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (login, pwd_hash, salt.hex(), phone.strip(), (email or "").strip(),
                 (name or "").strip(), telegram_id, ref_by, datetime.now().isoformat()),
            )
            return True, cur.lastrowid
    except sqlite3.IntegrityError:
        return False, "Этот логин уже занят — выберите другой"


def user_exists(login):
    with _conn() as c:
        return c.execute("SELECT 1 FROM users WHERE login=? COLLATE NOCASE", ((login or "").strip(),)).fetchone() is not None


def verify_user(login, password):
    """Return user dict on success, None on failure."""
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE login=? COLLATE NOCASE", ((login or "").strip(),)).fetchone()
    if not row:
        return None
    salt = bytes.fromhex(row["salt"])
    candidate = _hash_password(password or "", salt)
    if not hmac.compare_digest(candidate, row["password_hash"]):
        return None
    with _conn() as c:
        c.execute("UPDATE users SET last_login=? WHERE id=?", (datetime.now().isoformat(), row["id"]))
    return dict(row)


def get_user(login):
    with _conn() as c:
        row = c.execute("SELECT * FROM users WHERE login=? COLLATE NOCASE", ((login or "").strip(),)).fetchone()
    return dict(row) if row else None


def count_users():
    with _conn() as c:
        return c.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def list_users(limit=20):
    with _conn() as c:
        rows = c.execute("SELECT id,login,phone,email,name,created_at,last_login FROM users ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


init_db()
