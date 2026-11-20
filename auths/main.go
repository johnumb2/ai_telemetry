// Command auths is a tiny, self-contained login/auth server for the PULSE
// dashboard. It stores users and sessions in SQLite (pure-Go, no CGO) and
// issues HttpOnly session cookies. It also implements the nginx auth_request
// endpoint that gates the dashboard, plus forgot-password email links and
// user administration (add / edit / disable / admin-set passwords).
//
// Listens on 127.0.0.1:9341 (env AUTH_ADDR). The SQLite DB lives at
// DB_PATH (default /data/pulse.db). On first start, if the users table is
// empty it seeds the first (admin) account from INIT_USERNAME / INIT_EMAIL /
// INIT_PASSWORD (INIT_PASSWORD is required and fatal if missing).
//
// Reset emails are sent via SMTP when SMTP_HOST is set; otherwise the mail
// is written to a plain .eml file under MAIL_DIR (default /data/mail) so the
// flow keeps working with no SMTP server configured.
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"crypto/tls"
	"database/sql"
	"io"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

// ---- configuration from environment ----

type Config struct {
	Addr         string
	DBPath       string
	MailDir      string
	PublicBase   string
	SMTPHost     string
	SMTPPort     string
	SMTPUser     string
	SMTPPass     string
	SMTPFrom     string
	InitUser     string
	InitEmail    string
	InitPass     string
	CookieName   string
	CookieSecure bool
	SessionTTL   time.Duration
	TokenTTL     time.Duration
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() Config {
	cfg := Config{
		Addr:       envStr("AUTH_ADDR", "127.0.0.1:9341"),
		DBPath:     envStr("DB_PATH", "/data/pulse.db"),
		MailDir:    envStr("MAIL_DIR", "/data/mail"),
		PublicBase: strings.TrimSuffix(envStr("PUBLIC_BASE_URL", "http://127.0.0.1:8080"), "/"),
		SMTPHost:   envStr("SMTP_HOST", ""),
		SMTPPort:   envStr("SMTP_PORT", "587"),
		SMTPUser:   envStr("SMTP_USER", ""),
		SMTPPass:   envStr("SMTP_PASS", ""),
		SMTPFrom:   envStr("SMTP_FROM", "pulse-admin"),
		InitUser:   envStr("INIT_USERNAME", "johnumb"),
		InitEmail:  envStr("INIT_EMAIL", "johnumb@gmail.com"),
		InitPass:   envStr("INIT_PASSWORD", ""),
		CookieName: envStr("COOKIE_NAME", "pulse_session"),
		SessionTTL: 30 * 24 * time.Hour,
		TokenTTL:   48 * time.Hour,
	}
	cfg.CookieSecure = envStr("COOKIE_SECURE", "") == "true"
	return cfg
}

var (
	cfg Config
	db  *sql.DB
)

// ---- database setup ----

func dbOpen() error {
	if dir := filepath.Dir(cfg.DBPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("mkdir db dir: %w", err)
		}
	}
	dsn := "file:" + cfg.DBPath + "?_busy_timeout=5000"
	var err error
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	if err := db.Ping(); err != nil {
		return err
	}
	return migrate()
}

func migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users(
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE COLLATE NOCASE,
			email    TEXT NOT NULL UNIQUE COLLATE NOCASE,
			pass_hash TEXT NOT NULL,
			is_admin  INTEGER DEFAULT 0,
			disabled  INTEGER DEFAULT 0,
			created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions(
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS password_tokens(
			token_hash TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	return seedAdmin()
}

// Seed the first admin account on first start. It is only used when the
// users table is empty, and only if INIT_PASSWORD was provided.
func seedAdmin() error {
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if cfg.InitPass == "" {
		return fmt.Errorf("INIT_PASSWORD is required to seed the first admin account (set it in the container environment)")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(cfg.InitPass), 10)
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`INSERT INTO users(username, email, pass_hash, is_admin, disabled, created_at) VALUES(?,?,?,?,?,?)`,
		cfg.InitUser, cfg.InitEmail, string(hash), 1, 0,
		time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

// ---- user lookup ----

type userRow struct {
	ID        int
	Username  string
	Email     string
	PassHash  string
	IsAdmin   bool
	Disabled  bool
	CreatedAt string
}

func scanUser(id int) (*userRow, error) {
	var u userRow
	err := db.QueryRow(
		`SELECT id, username, email, pass_hash, is_admin, disabled, created_at FROM users WHERE id=?`,
		id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.PassHash, &u.IsAdmin, &u.Disabled, &u.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &u, err
}

// ---- random / hashed tokens ----

// parseTime parses an RFC3339 or basic ISO timestamp stored in SQLite.
func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("rand.Read: %v", err)
	}
	return hex.EncodeToString(b)
}

func tokenHash(tok string) string {
	h := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(h[:])
}

// ---- JSON response helpers ----

func writeJSON(w http.ResponseWriter, code int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("auths: bad encode: %v", err)
	}
}

func OK(w http.ResponseWriter, extra map[string]interface{}) {
	m := map[string]interface{}{"ok": true}
	for k, v := range extra {
		m[k] = v
	}
	writeJSON(w, 200, m)
}

func Err(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]interface{}{"ok": false, "error": msg})
}

// ---- session / auth resolution ----

func currentUser(r *http.Request) (*userRow, bool) {
	if r == nil {
		return nil, false
	}
	c, cErr := r.Cookie(cfg.CookieName)
	if cErr != nil || c == nil || c.Value == "" {
		return nil, false
	}
	var uID int
	var expStr string
	err := db.QueryRow(
		`SELECT user_id, expires_at FROM sessions WHERE id=?`, c.Value,
	).Scan(&uID, &expStr)
	exp, ok := parseTime(expStr)
	if err != nil || !ok || time.Now().After(exp) {
		return nil, false
	}
	u, err := scanUser(uID)
	if u == nil || err != nil || u.Disabled {
		return nil, false
	}
	return u, true
}

func newSessionToken(w http.ResponseWriter, userID int) error {
	tok := randomHex(24)
	now := time.Now().UTC()
	if _, err := db.Exec(
		`INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES(?,?,?,?)`,
		tok, userID, now.Format(time.RFC3339), now.Add(cfg.SessionTTL).Format(time.RFC3339),
	); err != nil {
		return err
	}
	setSessionCookie(w, tok)
	return nil
}

func setSessionCookie(w http.ResponseWriter, tok string) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.CookieName,
		Value:    tok,
		Path:     "/",
		MaxAge:   int(cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   cfg.CookieSecure,
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cfg.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
	})
}

func sessionIDFromReq(r *http.Request) string {
	c, err := r.Cookie(cfg.CookieName)
	if err != nil || c == nil {
		return ""
	}
	return c.Value
}

// ---- validation ----

func validUsername(u string) bool {
	if len(u) < 2 || len(u) > 32 {
		return false
	}
	for _, r := range u {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '.', r == '-':
		default:
			return false
		}
	}
	return true
}

func validEmail(e string) bool {
	_, err := mail.ParseAddress(e)
	if err != nil {
		return false
	}
	return strings.Contains(e, "@")
}

func validPassword(p string) bool {
	return len(p) >= 6 && len(p) <= 128
}

// ---- handlers (wired in main) ----

func main() {
	cfg = loadConfig()
	if cfg.InitPass == "" {
		log.Fatalf("INIT_PASSWORD environment variable is required to seed the first admin account on first run")
	}
	if err := dbOpen(); err != nil {
		log.Fatalf("auths db: %v", err)
	}
	log.Printf("auths: database ready at %s", cfg.DBPath)
	if err := os.MkdirAll(cfg.MailDir, 0o755); err != nil {
		log.Printf("auths: cannot create mail dir %s: %v", cfg.MailDir, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", hLogin)
	mux.HandleFunc("/api/session", hSession)
	mux.HandleFunc("/api/logout", hLogout)
	mux.HandleFunc("/api/forgot", hForgot)
	mux.HandleFunc("/api/reset", hReset)
	mux.HandleFunc("/api/session/password", hChangePassword)
	mux.HandleFunc("/authz", hAuthz)
	mux.HandleFunc("/api/users", hListUsers)
	mux.HandleFunc("/api/users/", hUsersByID)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]interface{}{"ok": true}) })

	log.Printf("auths listening on http://%s (db %s)", cfg.Addr, cfg.DBPath)
	log.Fatal(http.ListenAndServe(cfg.Addr, mux))
}

func hLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Err(w, 405, "method not allowed")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Err(w, 400, "invalid request body")
		return
	}
	var id, isAdmin, disabled int
	var passHash string
	var created string
	err := db.QueryRow(
		`SELECT id, is_admin, disabled, pass_hash, created_at FROM users WHERE username=? COLLATE NOCASE`,
		body.Username,
	).Scan(&id, &isAdmin, &disabled, &passHash, &created)
	if err == sql.ErrNoRows {
		// keep timing equal when no user exists
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$abcdefghijklmnopqrstuv"), []byte(body.Password))
		Err(w, 401, "invalid credentials")
		return
	}
	if err != nil {
		log.Printf("auths login query: %v", err)
		Err(w, 500, "internal error")
		return
	}
	if disabled == 1 {
		Err(w, 401, "account disabled")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passHash), []byte(body.Password)) != nil {
		Err(w, 401, "invalid credentials")
		return
	}
	if err := newSessionToken(w, id); err != nil {
		log.Printf("auths login session: %v", err)
		Err(w, 500, "internal error")
		return
	}
	u, _ := scanUser(id)
	OK(w, map[string]interface{}{"user": userPublic(u.ID, u.Username, u.Email, isAdmin == 1)})
}

func hSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		Err(w, 405, "method not allowed")
		return
	}
	u, authed := currentUser(r)
	if !authed {
		Err(w, 401, "not logged in")
		return
	}
	OK(w, map[string]interface{}{"user": userPublic(u.ID, u.Username, u.Email, u.IsAdmin)})
}

func hLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Err(w, 405, "method not allowed")
		return
	}
	if id := sessionIDFromReq(r); id != "" {
		_, _ = db.Exec(`DELETE FROM sessions WHERE id=?`, id)
	}
	clearSessionCookie(w)
	OK(w, nil)
}

func hForgot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Err(w, 405, "method not allowed")
		return
	}
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validEmail(body.Email) {
		Err(w, 400, "invalid email")
		return
	}
	var id, disabled int
	err := db.QueryRow(
		`SELECT id, disabled FROM users WHERE email=? COLLATE NOCASE`, body.Email,
	).Scan(&id, &disabled)
	if err == sql.ErrNoRows || disabled == 1 {
		// do not reveal whether the email exists
		OK(w, nil)
		return
	}
	if err != nil {
		log.Printf("auths forgot lookup: %v", err)
		Err(w, 500, "internal error")
		return
	}

	tok := randomHex(24)
	now := time.Now().UTC()
	if _, err := db.Exec(
		`INSERT OR REPLACE INTO password_tokens(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)`,
		tokenHash(tok), id, now.Format(time.RFC3339), now.Add(cfg.TokenTTL).Format(time.RFC3339),
	); err != nil {
		log.Printf("auths forgot token: %v", err)
		Err(w, 500, "internal error")
		return
	}

	link := cfg.PublicBase + "/reset?token=" + tok
	if err := sendResetEmail(body.Email, link); err != nil {
		log.Printf("auths forgot email: %v", err)
	}
	// always 200 to avoid account enumeration
	OK(w, nil)
}

func hReset(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		Err(w, 400, "missing token")
		return
	}
	if r.Method == http.MethodGet {
		if !validToken(tok) {
			Err(w, 400, "invalid or expired token")
			return
		}
		OK(w, nil)
		return
	}
	if r.Method != http.MethodPost {
		Err(w, 405, "method not allowed")
		return
	}
	var body struct {
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validPassword(body.NewPassword) {
		Err(w, 400, "invalid new password (min 6)")
		return
	}
	if !validToken(tok) {
		Err(w, 400, "invalid or expired token")
		return
	}
	var userID int
	err := db.QueryRow(`SELECT user_id FROM password_tokens WHERE token_hash=?`, tokenHash(tok)).Scan(&userID)
	if err == sql.ErrNoRows {
		Err(w, 400, "invalid or expired token")
		return
	}
	if err != nil {
		Err(w, 500, "internal error")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), 10)
	if err != nil {
		Err(w, 500, "internal error")
		return
	}
	tx, _ := db.Begin()
	if _, err := tx.Exec(`UPDATE users SET pass_hash=? WHERE id=?`, string(hash), userID); err != nil {
		tx.Rollback()
		Err(w, 500, "internal error")
		return
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=?`, userID); err != nil {
		tx.Rollback()
		Err(w, 500, "internal error")
		return
	}
	if _, err := tx.Exec(`DELETE FROM password_tokens WHERE token_hash=?`, tokenHash(tok)); err != nil {
		tx.Rollback()
		Err(w, 500, "internal error")
		return
	}
	if err := tx.Commit(); err != nil {
		Err(w, 500, "internal error")
		return
	}
	if err := newSessionToken(w, userID); err != nil {
		Err(w, 500, "internal error")
		return
	}
	OK(w, nil)
}

func validToken(tok string) bool {
	var expStr string
	err := db.QueryRow(`SELECT expires_at FROM password_tokens WHERE token_hash=?`, tokenHash(tok)).Scan(&expStr)
	if err != nil {
		return false
	}
	exp, ok := parseTime(expStr)
	if !ok || time.Now().After(exp) {
		return false
	}
	return true
}

func hChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Err(w, 405, "method not allowed")
		return
	}
	u, authed := currentUser(r)
	if !authed {
		Err(w, 401, "not logged in")
		return
	}
	var body struct {
		Current     string `json:"current_password"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validPassword(body.NewPassword) {
		Err(w, 400, "invalid new password (min 6)")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(u.PassHash), []byte(body.Current)) != nil {
		Err(w, 400, "current password is wrong")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), 10)
	if err != nil {
		Err(w, 500, "internal error")
		return
	}
	tx, _ := db.Begin()
	if _, err := tx.Exec(`UPDATE users SET pass_hash=? WHERE id=?`, string(hash), u.ID); err != nil {
		tx.Rollback()
		Err(w, 500, "internal error")
		return
	}
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=? AND id<>?`, u.ID, sessionIDFromReq(r)); err != nil {
		tx.Rollback()
		Err(w, 500, "internal error")
		return
	}
	if err := tx.Commit(); err != nil {
		Err(w, 500, "internal error")
		return
	}
	OK(w, nil)
}

// hAuthz is the nginx auth_request subrequest target.
func hAuthz(w http.ResponseWriter, r *http.Request) {
	_, authed := currentUser(r)
	if authed {
		// refresh sliding window on every gated request
		if id := sessionIDFromReq(r); id != "" {
			exp := time.Now().UTC().Add(cfg.SessionTTL)
			_, _ = db.Exec(`UPDATE sessions SET expires_at=? WHERE id=?`, exp.Format(time.RFC3339), id)
		}
		w.WriteHeader(200)
		return
	}
	// auth_request must return 401 with an empty body for nginx to deny
	w.Header().Del("Content-Type")
	w.WriteHeader(401)
}

// ---- admin / user management ----

// Handles GET /api/users (list) and POST /api/users (admin creates a user).
func hListUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		u, authed := currentUser(r)
		if !authed || !u.IsAdmin {
			Err(w, 403, "admin required")
			return
		}
		user, status, msg := createUser(r)
		if msg != "" {
			Err(w, status, msg)
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "user": user})
		return
	}
	if r.Method != http.MethodGet {
		Err(w, 405, "method not allowed")
		return
	}
	u, authed := currentUser(r)
	if !authed || !u.IsAdmin {
		Err(w, 403, "admin required")
		return
	}
	rows, err := db.Query(`SELECT id, username, email, is_admin, disabled, created_at FROM users ORDER BY id`)
	if err != nil {
		Err(w, 500, "internal error")
		return
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var id, isAdmin, disabled int
		var un, em, created string
		if err := rows.Scan(&id, &un, &em, &isAdmin, &disabled, &created); err != nil {
			break
		}
		out = append(out, map[string]interface{}{
			"id": id, "username": un, "email": em,
			"admin": isAdmin == 1, "disabled": disabled == 1,
			"created_at": created,
		})
	}
	writeJSON(w, 200, map[string]interface{}{"users": out})
}

// hUsersByID handles /api/users/{id} and /api/users/{id}/password (admin only).
func hUsersByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/users/")
	isPassword := false
	if strings.HasSuffix(rest, "/password") {
		rest = strings.TrimSuffix(rest, "/password")
		isPassword = true
	}
	id, err := strconv.Atoi(rest)
	if err != nil || id <= 0 {
		Err(w, 400, "invalid user id")
		return
	}

	admin, authed := currentUser(r)
	if !authed || !admin.IsAdmin {
		Err(w, 403, "admin required")
		return
	}

	target, sErr := scanUser(id)
	if sErr != nil || target == nil {
		Err(w, 404, "user not found")
		return
	}

	if isPassword {
		if r.Method != http.MethodPost {
			Err(w, 405, "method not allowed")
			return
		}
		var body struct {
			NewPassword string `json:"new_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validPassword(body.NewPassword) {
			Err(w, 400, "invalid password (min 6)")
			return
		}
		hash, _ := bcrypt.GenerateFromPassword([]byte(body.NewPassword), 10)
		if _, err := db.Exec(`UPDATE users SET pass_hash=? WHERE id=?`, string(hash), id); err != nil {
			Err(w, 500, "internal error")
			return
		}
		if _, err := db.Exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
			Err(w, 500, "internal error")
			return
		}
		OK(w, nil)
		return
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]interface{}{"user": userPublic(id, target.Username, target.Email, target.IsAdmin)})
	case http.MethodPatch:
		var body struct {
			Email    *string `json:"email"`
			Admin    *bool   `json:"admin"`
			Disabled *bool   `json:"disabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Err(w, 400, "invalid body")
			return
		}
		if body.Email != nil && !validEmail(*body.Email) {
			Err(w, 400, "invalid email")
			return
		}
		if id == admin.ID && (body.Admin != nil && !*body.Admin || (body.Disabled != nil && *body.Disabled)) {
			Err(w, 400, "cannot demote or disable yourself")
			return
		}
		tx, _ := db.Begin()
		if body.Email != nil {
			if _, err := tx.Exec(`UPDATE users SET email=? WHERE id=?`, *body.Email, id); err != nil {
				tx.Rollback()
				Err(w, 500, "internal error")
				return
			}
		}
		if body.Admin != nil {
			if _, err := tx.Exec(`UPDATE users SET is_admin=? WHERE id=?`, boolToInt(*body.Admin), id); err != nil {
				tx.Rollback()
				Err(w, 500, "internal error")
				return
			}
		}
		if body.Disabled != nil {
			if _, err := tx.Exec(`UPDATE users SET disabled=? WHERE id=?`, boolToInt(*body.Disabled), id); err != nil {
				tx.Rollback()
				Err(w, 500, "internal error")
				return
			}
			if *body.Disabled {
				if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
					tx.Rollback()
					Err(w, 500, "internal error")
					return
				}
			}
		}
		if err := tx.Commit(); err != nil {
			Err(w, 500, "internal error")
			return
		}
		t, _ := scanUser(id)
		writeJSON(w, 200, map[string]interface{}{"ok": true, "user": userPublic(id, t.Username, t.Email, t.IsAdmin)})
	default:
		Err(w, 405, "method not allowed")
	}
}

// createUser validates the body and inserts a new user. Returns the created
// user's public shape, an HTTP status, and an error message ("" on success).
func createUser(r *http.Request) (map[string]interface{}, int, string) {
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !validUsername(body.Username) || !validEmail(body.Email) || !validPassword(body.Password) {
		return nil, 400, "invalid username, email, or password (min 6 chars)"
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(body.Password), 10)
	_, err := db.Exec(
		`INSERT INTO users(username, email, pass_hash, is_admin, disabled, created_at) VALUES(?,?,?,?,?,?)`,
		body.Username, body.Email, string(hash), boolToInt(body.IsAdmin), 0,
		time.Now().UTC().Format(time.RFC3339),
	)
	if err != nil {
		return nil, 400, "user not created (username or email already exists)"
	}
	var nid int
	_ = db.QueryRow(`SELECT id FROM users WHERE username=? COLLATE NOCASE`, body.Username).Scan(&nid)
	return userPublic(nid, body.Username, body.Email, body.IsAdmin), 0, ""
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func userPublic(id int, username, email string, isAdmin bool) map[string]interface{} {
	return map[string]interface{}{
		"id": id, "username": username, "email": email, "admin": isAdmin,
	}
}

// ---- email (SMTP or local file when SMTP not configured) ----

func sendResetEmail(to, link string) error {
	subject := "PULSE: reset your dashboard password"
	body := "You requested a password reset for your PULSE dashboard.\n\nGo to this link to set a new password (expires in 48h):\n\n" + link + "\n\n" +
		"If you did not request this, you can ignore this email."

	from := cfg.SMTPFrom
	if from == "" {
		from = "pulse-admin"
	}
	addr := strings.Trim(to, "<>")

	if cfg.SMTPHost == "" {
		return writeMailFile(addr, from, subject, body)
	}

	relay := net.JoinHostPort(cfg.SMTPHost, cfg.SMTPPort)
	conn, err := smtp.Dial(relay)
	if err != nil {
		return err
	}
	defer conn.Close()
	if cfg.SMTPUser != "" {
		if err := conn.StartTLS(&tls.Config{}); err != nil {
			return err
		}
		auth := smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPass, cfg.SMTPHost)
		if err := conn.Auth(auth); err != nil {
			return err
		}
	}
	fromAddr := from
	if i := strings.LastIndex(from, "<"); i >= 0 && strings.Contains(from[i:], ">") {
		fromAddr = from[i+1 : strings.LastIndex(from, ">")]
	}
	if err := conn.Mail(fromAddr); err != nil {
		return err
	}
	if err := conn.Rcpt(addr); err != nil {
		return err
	}
	w, err := conn.Data()
	if err != nil {
		return err
	}
	if _, err := io.WriteString(w, body); err != nil {
		return err
	}
	return w.Close()
}

func writeMailFile(to, from, subject, body string) error {
	file := fmt.Sprintf("reset-%d-%s.eml", time.Now().Unix(), to)
	fn := filepath.Join(cfg.MailDir, file)
	msg := "To: " + to + "\nFrom: " + from + "\nSubject: " + subject + "\n\n" + body + "\n"
	if err := os.WriteFile(fn, []byte(msg), 0o644); err != nil {
		return err
	}
	log.Printf("auths: reset mail written to %s (no SMTP configured; point SMTP_HOST at a relay to enable real email)", fn)
	return nil
}
