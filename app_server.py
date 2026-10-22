import ctypes
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import webbrowser
from contextlib import contextmanager
from ctypes import wintypes
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "PallaviPhysio"
DB_PATH = DATA_DIR / "clinic.db"
BACKUP_DIR = DATA_DIR / "backups"
HOST = "127.0.0.1"
PORT = 8765
SESSION_HOURS = 8
MAX_BODY = 5 * 1024 * 1024


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def protect_data(value):
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is required to protect the clinic database.")
    source = ctypes.create_string_buffer(value)
    source_blob = DataBlob(len(value), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    result_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source_blob), "Pallavi Physio clinic records",
        None, None, None, 0x1, ctypes.byref(result_blob)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result_blob.pbData, result_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(result_blob.pbData)


def unprotect_data(value):
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is required to read the clinic database.")
    source = ctypes.create_string_buffer(value)
    source_blob = DataBlob(len(value), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    result_blob = DataBlob()
    description = wintypes.LPWSTR()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source_blob), ctypes.byref(description),
        None, None, None, 0x1, ctypes.byref(result_blob)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result_blob.pbData, result_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(result_blob.pbData)


@contextmanager
def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=10000")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database():
    with connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                username TEXT NOT NULL UNIQUE,
                password_salt BLOB NOT NULL,
                password_hash BLOB NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS clinic_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL,
                protected_payload BLOB NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash BLOB PRIMARY KEY,
                csrf_token TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS login_attempts (
                username_key TEXT NOT NULL,
                attempted_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                event TEXT NOT NULL,
                occurred_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_attempts_recent ON login_attempts(attempted_at);
        """)


def audit(db, username, event):
    db.execute(
        "INSERT INTO audit_log(username, event, occurred_at) VALUES (?, ?, ?)",
        (username, event, datetime.now(timezone.utc).isoformat())
    )


def backup_database():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = BACKUP_DIR / f"clinic-{date.today().isoformat()}.db"
    if DB_PATH.exists():
        temporary_path = backup_path.with_suffix(".tmp")
        try:
            source = sqlite3.connect(DB_PATH)
            destination = sqlite3.connect(temporary_path)
            try:
                source.backup(destination)
            finally:
                destination.close()
                source.close()
            os.replace(temporary_path, backup_path)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()
    for old_backup in BACKUP_DIR.glob("clinic-*.db"):
        try:
            if (date.today() - date.fromisoformat(old_backup.stem[7:])).days > 30:
                old_backup.unlink()
        except (ValueError, OSError):
            continue


def daily_backup_loop():
    while True:
        now = datetime.now()
        tomorrow = datetime.combine(now.date(), datetime.min.time()) + timedelta(days=1)
        time.sleep(max(1, (tomorrow - now).total_seconds()))
        try:
            backup_database()
        except OSError:
            print("Daily encrypted backup could not be refreshed. Check available disk space and folder access.")


def password_hash(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)


def token_digest(token):
    return hashlib.sha256(token.encode("ascii")).digest()


def default_state():
    return {
        "patients": [],
        "visits": [],
        "clinic": {
            "name": "Dr. Pallavi Chogale Physiotherapy Clinic",
            "brandName": "Pallavi Physio",
            "doctor": "Dr. Pallavi Chogale",
            "providerTitle": "Physiotherapist",
            "specialty": "Physiotherapy",
            "serviceLabel": "Session",
            "serviceLabelPlural": "Sessions",
            "serviceDescription": "Physiotherapy session",
            "brandColor": "purple",
            "address": "",
            "phone": "",
            "email": "",
            "gstin": "",
        },
    }


def validate_state(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("patients"), list) or not isinstance(payload.get("visits"), list):
        raise ValueError("The clinic data format is invalid.")
    patients = payload["patients"]
    visits = payload["visits"]
    if len(patients) > 2000 or len(visits) > 100000:
        raise ValueError("The clinic record limit was exceeded.")
    patient_ids = set()
    visit_ids = set()
    for patient in patients:
        if not isinstance(patient, dict) or not isinstance(patient.get("id"), str) or not isinstance(patient.get("name"), str):
            raise ValueError("A patient record is invalid.")
        if len(patient["name"]) > 100 or len(patient["id"]) > 100 or patient["id"] in patient_ids:
            raise ValueError("A patient record contains invalid or duplicate values.")
        if any(len(str(patient.get(key, ""))) > limit for key, limit in (
            ("dob", 10), ("gender", 30), ("phone", 25), ("emergency", 25), ("address", 180), ("createdAt", 10)
        )):
            raise ValueError("A patient record contains a field that is too long.")
        for key, optional in (("dob", True), ("createdAt", False)):
            value = str(patient.get(key, ""))
            if value and (not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or date.fromisoformat(value).isoformat() != value):
                raise ValueError("A patient record contains an invalid date.")
            if not optional and not value:
                raise ValueError("A patient record is missing its registration date.")
        patient_ids.add(patient["id"])
    for visit in visits:
        if not isinstance(visit, dict) or visit.get("patientId") not in patient_ids:
            raise ValueError("A session refers to an unknown patient.")
        visit_id = visit.get("id")
        if not isinstance(visit_id, str) or not visit_id or visit_id in visit_ids:
            raise ValueError("A session has a missing or duplicate identifier.")
        visit_ids.add(visit_id)
        if any(len(str(visit.get(key, ""))) > limit for key, limit in (
            ("id", 100), ("date", 10), ("time", 5), ("followUpDate", 10), ("billingType", 40), ("status", 30)
        )):
            raise ValueError("A session contains a field that is too long.")
        for key, optional in (("date", False), ("followUpDate", True)):
            value = str(visit.get(key, ""))
            if value and (not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or date.fromisoformat(value).isoformat() != value):
                raise ValueError("A session contains an invalid date.")
            if not optional and not value:
                raise ValueError("A session is missing its appointment date.")
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(visit.get("time", ""))):
            raise ValueError("A session contains an invalid appointment time.")
        try:
            fee = float(visit.get("fee", 0))
            paid = float(visit.get("amountPaid", 0))
            base_fee = float(visit.get("baseFee", fee))
        except (TypeError, ValueError):
            raise ValueError("A session has invalid payment values.") from None
        if not all(map(lambda value: value >= 0 and value < 1_000_000_000, (fee, paid, base_fee))) or paid > fee:
            raise ValueError("A session has invalid payment values.")
        for key, limit in (("department", 70), ("clinician", 100), ("reason", 180)):
            if len(str(visit.get(key, ""))) > limit:
                raise ValueError("A session contains a field that is too long.")
        payments = visit.get("payments", [])
        if not isinstance(payments, list) or len(payments) > 1000:
            raise ValueError("A session payment history is invalid.")
        payment_sum = 0.0
        payment_ids = set()
        for payment in payments:
            if not isinstance(payment, dict):
                raise ValueError("A payment record is invalid.")
            try:
                amount = float(payment.get("amount", 0))
            except (TypeError, ValueError):
                raise ValueError("A payment record has an invalid amount.") from None
            if amount <= 0 or amount >= 1_000_000_000 or any(len(str(payment.get(key, ""))) > limit for key, limit in (
                ("id", 100), ("method", 40), ("date", 10), ("invoiceNumber", 60)
            )):
                raise ValueError("A payment record contains invalid values.")
            payment_id = payment.get("id")
            payment_date = str(payment.get("date", ""))
            if not isinstance(payment_id, str) or not payment_id or payment_id in payment_ids:
                raise ValueError("A payment has a missing or duplicate identifier.")
            if not payment_date or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", payment_date) or date.fromisoformat(payment_date).isoformat() != payment_date:
                raise ValueError("A payment record contains an invalid date.")
            payment_ids.add(payment_id)
            payment_sum += amount
        if abs(payment_sum - paid) > 0.01:
            raise ValueError("The session payment history does not match its amount received.")
    clinic = payload.get("clinic", {})
    if not isinstance(clinic, dict) or any(len(str(clinic.get(key, ""))) > limit for key, limit in (
        ("name", 120), ("brandName", 32), ("doctor", 100), ("providerTitle", 60), ("specialty", 60),
        ("serviceLabel", 24), ("serviceLabelPlural", 24), ("serviceDescription", 80),
        ("address", 200), ("phone", 25), ("email", 120), ("gstin", 20)
    )):
        raise ValueError("Clinic details are invalid.")
    if clinic.get("brandColor", "purple") not in ("purple", "blue", "teal"):
        raise ValueError("The clinic accent color is not supported.")
    return payload


class ClinicServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    server_version = "PallaviPhysio"
    sys_version = ""

    def log_message(self, format_string, *args):
        # Avoid writing request payloads or patient identifiers to server logs.
        print(f"{self.log_date_time_string()} {self.command} {urlsplit(self.path).path}")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, status, value, headers=None):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for key, item in headers.items():
                self.send_header(key, item)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise ValueError("Send data using application/json.")
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_BODY:
            raise ValueError("Request size is invalid.")
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Request data is invalid.") from None

    def _origin_allowed(self, require_origin=False):
        expected = f"http://{self.headers.get('Host', '')}"
        origin = self.headers.get("Origin")
        return (not require_origin or origin == expected) and (not origin or origin == expected) and self.headers.get("Host") in (
            f"127.0.0.1:{PORT}", f"localhost:{PORT}"
        )

    def _session(self):
        cookies = self.headers.get("Cookie", "")
        token = next((part.strip()[len("ppsession="):] for part in cookies.split(";") if part.strip().startswith("ppsession=")), "")
        if not token or len(token) != 64:
            return None
        with connect() as db:
            row = db.execute(
                "SELECT s.csrf_token, s.expires_at, u.username FROM sessions s CROSS JOIN users u "
                "WHERE s.token_hash=? AND u.id=1", (token_digest(token),)
            ).fetchone()
            if not row or row["expires_at"] < int(time.time()):
                if row:
                    db.execute("DELETE FROM sessions WHERE token_hash=?", (token_digest(token),))
                return None
            return {"csrf": row["csrf_token"], "username": row["username"]}

    def _require_session(self):
        session = self._session()
        if not session:
            self._json(401, {"error": "Your session ended. Sign in again."})
            return None
        if not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), session["csrf"]):
            self._json(403, {"error": "Request verification failed. Refresh and try again."})
            return None
        return session

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/") and not self._origin_allowed():
            self._json(403, {"error": "This local clinic server only accepts its own browser origin."})
            return
        if path == "/api/session":
            session = self._session()
            with connect() as db:
                configured = db.execute("SELECT 1 FROM users WHERE id=1").fetchone() is not None
            self._json(200, {
                "configured": configured,
                "authenticated": bool(session),
                "username": session["username"] if session else "",
                "csrf": session["csrf"] if session else "",
            })
            return
        if path == "/api/state":
            session = self._session()
            if not session:
                self._json(401, {"error": "Sign in to open clinic records."})
                return
            with connect() as db:
                row = db.execute("SELECT revision, protected_payload FROM clinic_state WHERE id=1").fetchone()
            if not row:
                self._json(503, {"error": "Clinic database is not initialized."})
                return
            try:
                payload = json.loads(unprotect_data(row["protected_payload"]))
            except (OSError, ValueError, json.JSONDecodeError, ctypes.ArgumentError):
                self._json(500, {"error": "Clinic data could not be decrypted for this Windows account. Data was not replaced."})
                return
            self._json(200, {"revision": row["revision"], "state": payload})
            return
        if path == "/api/backup":
            session = self._require_session()
            if not session:
                return
            try:
                backup_database()
                backup_path = BACKUP_DIR / f"clinic-{date.today().isoformat()}.db"
                body = backup_path.read_bytes()
            except OSError:
                self._json(500, {"error": "The protected database backup could not be prepared."})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="pallavi-physio-encrypted-backup-{date.today().isoformat()}.db"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            with connect() as db:
                audit(db, session["username"], "encrypted_backup_downloaded")
            return
        if path in ("/", "/index.html"):
            file_path = ROOT / "index.html"
        elif path in ("/app.js", "/styles.css"):
            file_path = ROOT / path.lstrip("/")
        else:
            self.send_error(404)
            return
        try:
            body = file_path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = "text/html; charset=utf-8" if file_path.suffix == ".html" else "text/javascript; charset=utf-8" if file_path.suffix == ".js" else "text/css; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._origin_allowed(require_origin=True):
            self._json(403, {"error": "This local clinic server only accepts its own browser origin."})
            return
        path = urlsplit(self.path).path
        try:
            payload = self._read_json()
        except (ValueError, OverflowError):
            self._json(400, {"error": "Request data is invalid or too large."})
            return
        if path == "/api/setup":
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            if not 3 <= len(username) <= 80 or len(password) < 14 or len(password) > 1024:
                self._json(400, {"error": "Choose a username (3–80 characters) and a unique password of at least 14 characters."})
                return
            salt = secrets.token_bytes(16)
            now = int(time.time())
            token = secrets.token_hex(32)
            csrf = secrets.token_urlsafe(32)
            try:
                with connect() as db:
                    if db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                        self._json(409, {"error": "The clinic owner account has already been created."})
                        return
                    db.execute(
                        "INSERT INTO users(id, username, password_salt, password_hash, created_at) VALUES (1, ?, ?, ?, ?)",
                        (username, salt, password_hash(password, salt), datetime.now(timezone.utc).isoformat())
                    )
                    db.execute(
                        "INSERT INTO clinic_state(id, revision, protected_payload, updated_at) VALUES (1, 1, ?, ?)",
                        (protect_data(json.dumps(default_state()).encode("utf-8")), datetime.now(timezone.utc).isoformat())
                    )
                    db.execute("INSERT INTO sessions(token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)",
                               (token_digest(token), csrf, now + SESSION_HOURS * 3600, now))
                    audit(db, username, "owner_account_created")
                backup_database()
            except sqlite3.IntegrityError:
                self._json(409, {"error": "The clinic owner account has already been created."})
                return
            except (OSError, RuntimeError):
                self._json(500, {"error": "Secure database protection could not be initialized. No clinic data was saved."})
                return
            self._json(201, {"csrf": csrf, "username": username},
                       {"Set-Cookie": f"ppsession={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_HOURS * 3600}"})
            return
        if path == "/api/login":
            username = str(payload.get("username", "")).strip()
            password = str(payload.get("password", ""))
            key = hashlib.sha256(username.casefold().encode("utf-8")).hexdigest()
            now = int(time.time())
            with connect() as db:
                db.execute("DELETE FROM login_attempts WHERE attempted_at < ?", (now - 900,))
                attempts = db.execute("SELECT COUNT(*) FROM login_attempts WHERE username_key=?", (key,)).fetchone()[0]
                row = db.execute("SELECT username, password_salt, password_hash FROM users WHERE id=1").fetchone()
                if attempts >= 5:
                    self._json(429, {"error": "Too many sign-in attempts. Wait 15 minutes and try again."})
                    return
                salt = row["password_salt"] if row else b"clinic-dummy1234"
                candidate = password_hash(password[:1024], salt)
                valid = bool(row) and hmac.compare_digest(candidate, row["password_hash"]) and hmac.compare_digest(
                    username.casefold().encode("utf-8"), row["username"].casefold().encode("utf-8")
                )
                db.execute("INSERT INTO login_attempts(username_key, attempted_at) VALUES (?, ?)", (key, now))
                if not valid:
                    audit(db, "system", "sign_in_failed")
                    self._json(401, {"error": "Username or password is incorrect."})
                    return
                db.execute("DELETE FROM login_attempts WHERE username_key=?", (key,))
                token = secrets.token_hex(32)
                csrf = secrets.token_urlsafe(32)
                db.execute("INSERT INTO sessions(token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?)",
                           (token_digest(token), csrf, now + SESSION_HOURS * 3600, now))
                audit(db, row["username"], "sign_in")
            self._json(200, {"csrf": csrf, "username": row["username"]},
                       {"Set-Cookie": f"ppsession={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_HOURS * 3600}"})
            return
        session = self._require_session()
        if not session:
            return
        if path == "/api/logout":
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (token_digest(self._cookie_token()),))
                audit(db, session["username"], "sign_out")
            self._json(200, {"ok": True}, {"Set-Cookie": "ppsession=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            return
        self._json(404, {"error": "Not found."})

    def do_PUT(self):
        if not self._origin_allowed(require_origin=True):
            self._json(403, {"error": "This local clinic server only accepts its own browser origin."})
            return
        session = self._require_session()
        if not session:
            return
        if urlsplit(self.path).path != "/api/state":
            self._json(404, {"error": "Not found."})
            return
        try:
            request = self._read_json()
            expected_revision = int(request.get("revision"))
            new_state = validate_state(request.get("state"))
            encrypted = protect_data(json.dumps(new_state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        except (ValueError, TypeError, OverflowError) as error:
            self._json(400, {"error": str(error) or "Clinic record is invalid."})
            return
        except (OSError, RuntimeError):
            self._json(500, {"error": "Secure database protection failed. The previous saved data is unchanged."})
            return
        with connect() as db:
            row = db.execute("SELECT revision FROM clinic_state WHERE id=1").fetchone()
            if not row or row["revision"] != expected_revision:
                self._json(409, {"error": "Clinic records changed in another session. Reload the page before making more changes."})
                return
            next_revision = expected_revision + 1
            db.execute(
                "UPDATE clinic_state SET revision=?, protected_payload=?, updated_at=? WHERE id=1",
                (next_revision, encrypted, datetime.now(timezone.utc).isoformat())
            )
            audit(db, session["username"], "clinic_data_saved")
        warning = ""
        try:
            backup_database()
        except OSError:
            warning = "Records were saved, but the daily backup could not be created. Check disk space and folder access."
        self._json(200, {"revision": next_revision, "warning": warning})

    def _cookie_token(self):
        cookies = self.headers.get("Cookie", "")
        return next((part.strip()[len("ppsession="):] for part in cookies.split(";") if part.strip().startswith("ppsession=")), "")


def main():
    if os.name != "nt":
        raise SystemExit("This first secure backend build requires Windows DPAPI and runs only on Windows.")
    initialize_database()
    backup_database()
    server = ClinicServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print("Pallavi Physio clinic backend is running on this computer only.")
    print(f"Open {url}; keep this window open while using the clinic app.")
    threading.Thread(target=daily_backup_loop, daemon=True).start()
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nClinic server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
