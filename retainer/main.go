// Command retainer records the live vLLM and host-metrics scrapes to a
// SQLite history DB so the PULSE dashboard can recall what was happening
// over the last RETENTION_DAYS (default 90). It serves a small query API
// that computes the same derived stats the live view derives (gauge / total
// / rate / p50 / p95 / windowed mean / invMean / ratio) straight from the
// stored 1-minute-resolution samples, so history charts match the live ones.
package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// ---- config ----

type RetainerConfig struct {
	Addr         string
	DBPath       string
	VLLMURL      string
	HostURL      string
	IntervalSec  int
	RetentionDays int
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func loadConfig() RetainerConfig {
	return RetainerConfig{
		Addr:          envStr("RETAINER_ADDR", "127.0.0.1:9342"),
		DBPath:        envStr("RETAINER_DB_PATH", "/data/history.db"),
		VLLMURL:       envStr("RETAINER_VLLM_URL", envStr("METRICS_URL", "http://host.docker.internal:18982/metrics")),
		HostURL:       envStr("RETAINER_HOST_URL", "http://127.0.0.1:9340/metrics"),
		IntervalSec:   envInt("RETAINER_INTERVAL_SECONDS", 15),
		RetentionDays: envInt("RETAINER_RETENTION_DAYS", 90),
	}
}

var (
	cfg RetainerConfig
	db  *sql.DB
)

// ---- database setup ----

func dbOpen() error {
	if dir := filepath.Dir(cfg.DBPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	dsn := "file:" + cfg.DBPath + "?_busy_timeout=5000&_journal_mode=WAL&_auto_vacuum=incremental"
	var err error
	db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	if err := db.Ping(); err != nil {
		return err
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS samples(
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			source TEXT NOT NULL,
			skey TEXT NOT NULL,
			name TEXT NOT NULL,
			value REAL NOT NULL,
			UNIQUE(source, skey, ts))`,
		`CREATE INDEX IF NOT EXISTS idx_samples_skey ON samples(source, skey, ts)`,
		`CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	return nil
}

func pruneRetention() {
	cutoff := time.Now().Add(-time.Duration(cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
	res, err := db.Exec(`DELETE FROM samples WHERE ts < ?`, cutoff)
	if err != nil {
		log.Printf("retainer: prune: %v", err)
		return
	}
	if n, err := res.RowsAffected(); err == nil {
		log.Printf("retainer: pruned %d rows older than %d days", n, cfg.RetentionDays)
	}
}

// ---- Prometheus text parsing (line-level, defensive) ----

type seriesEntry struct {
	Name   string
	Labels map[string]string
	Value  float64
}

func isNameChar(c byte) bool {
	return c == ':' || c == '-' || c == '.' || c == '_' ||
		(c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func parseMetricLine(line string) (name string, labels map[string]string, value float64, ok bool) {
	labels = map[string]string{}
	i := 0
	for i < len(line) && isNameChar(line[i]) {
		i++
	}
	if i == 0 {
		return "", nil, 0, false
	}
	name = line[:i]
	rest := strings.TrimSpace(line[i:])
	if strings.HasPrefix(rest, "{") {
		inner := strings.TrimSpace(rest[1:])
		if k := strings.IndexByte(inner, '}'); k >= 0 {
			inner = inner[:k]
		}
		for _, part := range strings.Split(inner, ",") {
			p := strings.TrimSpace(part)
			eq := strings.IndexByte(p, '=')
			if eq <= 0 {
				continue
			}
			k := strings.TrimSpace(p[:eq])
			v := strings.TrimSpace(p[eq+1:])
			if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
				v = v[1 : len(v)-1]
			}
			labels[k] = v
		}
	}
	toks := strings.Fields(rest)
	if len(toks) == 0 {
		return "", nil, 0, false
	}
	f, err := strconv.ParseFloat(toks[len(toks)-1], 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return "", nil, 0, false
	}
	return name, labels, f, true
}

func parsePrometheus(body string) []seriesEntry {
	var out []seriesEntry
	for _, line := range strings.Split(body, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		name, labels, value, ok := parseMetricLine(t)
		if !ok || name == "" {
			continue
		}
		out = append(out, seriesEntry{Name: name, Labels: labels, Value: value})
	}
	return out
}

// skeyOf renders the frontend-compatible series key: `name|k=v,k2=v2` (sorted).
func skeyOf(name string, labels map[string]string) string {
	ks := make([]string, 0, len(labels))
	for k := range labels {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	parts := make([]string, 0, len(ks))
	for _, k := range ks {
		parts = append(parts, k+"="+labels[k])
	}
	if len(parts) == 0 {
		return name
	}
	return name + "|" + strings.Join(parts, ",")
}

// stripLe drops the `le` label from a series key's label tail.
func stripLe(skey string) string {
	idx := strings.IndexByte(skey, '|')
	if idx < 0 {
		return skey
	}
	name, tail := skey[:idx], skey[idx+1:]
	pairs := strings.Split(tail, ",")
	keep := make([]string, 0, len(pairs))
	for _, p := range pairs {
		eq := strings.IndexByte(p, '=')
		if eq > 0 && p[:eq] == "le" {
			continue
		}
		keep = append(keep, p)
	}
	if len(keep) == 0 {
		return name
	}
	return name + "|" + strings.Join(keep, ",")
}

func labelsOf(skey string) map[string]string {
	out := map[string]string{}
	idx := strings.IndexByte(skey, '|')
	if idx < 0 {
		return out
	}
	for _, p := range strings.Split(skey[idx+1:], ",") {
		eq := strings.IndexByte(p, '=')
		if eq > 0 {
			out[p[:eq]] = p[eq+1:]
		}
	}
	return out
}

func nameOf(skey string) string {
	if i := strings.IndexByte(skey, '|'); i >= 0 {
		return skey[:i]
	}
	return skey
}

// matchCombo reports whether a series key's labels cover every k=v in combo
// (order-insensitive; `le` is ignored).
func matchCombo(skey string, combo string) bool {
	if combo == "" {
		return true
	}
	lbl := labelsOf(skey)
	for _, p := range strings.Split(combo, ",") {
		eq := strings.IndexByte(p, '=')
		if eq <= 0 {
			continue
		}
		if lbl[p[:eq]] != p[eq+1:] {
			return false
		}
	}
	return true
}

// ---- scrape store (1-minute resolution, deduped) ----

type cacheKey struct {
	source string
	skey   string
}

type cacheVal struct {
	minute int64
	value  float64
}

var storeCache = map[cacheKey]*cacheVal{}
var storeMu sync.Mutex

func scrapeOnce() {
	type su struct{ source, url string }
	for _, x := range []su{
		{"vllm", cfg.VLLMURL},
		{"host", cfg.HostURL},
	} {
		body := httpGet(x.url, 10*time.Second)
		if body == "" {
			log.Printf("retainer: scrape %s failed", x.source)
			continue
		}
		storeSource(x.source, body)
	}
}

func httpGet(url string, timeout time.Duration) string {
	c := http.Client{Timeout: timeout}
	resp, err := c.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	var sb strings.Builder
	const maxBytes = 8 * 1024 * 1024
	wrote := 0
	buf := make([]byte, 8192)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			sb.Write(buf[:n])
			wrote += n
			if wrote > maxBytes {
				break
			}
		}
		if err != nil {
			break
		}
	}
	return sb.String()
}

func storeSource(source, body string) {
	series := parsePrometheus(body)
	if len(series) == 0 {
		return
	}
	minute := time.Now().UnixMilli() / 60000 * 60000

	storeMu.Lock()
	defer storeMu.Unlock()
	for _, s := range series {
		k := skeyOf(s.Name, s.Labels)
		ck := cacheKey{source, k}
		cv := storeCache[ck]
		if cv == nil {
			// load the last stored value for this series once per process start
			ts, v, ok := lastStored(source, k)
			if ok {
				storeCache[ck] = &cacheVal{minute: ts, value: v}
				cv = storeCache[ck]
			} else {
				cv = &cacheVal{}
				storeCache[ck] = cv
			}
		}
		if cv.minute == minute && cv.value == s.Value {
			continue // unchanged within this minute — no point writing
		}
		if _, err := db.Exec(
			`INSERT INTO samples(ts, source, skey, name, value) VALUES(?,?,?,?,?)
			 ON CONFLICT(source, skey, ts) DO UPDATE SET value=excluded.value, name=excluded.name`,
			minute, source, k, s.Name, s.Value); err != nil {
			log.Printf("retainer: upsert: %v", err)
			continue
		}
		cv.minute = minute
		cv.value = s.Value
	}
}

func lastStored(source, skey string) (int64, float64, bool) {
	var ts int64
	var v float64
	err := db.QueryRow(`SELECT ts, value FROM samples WHERE source=? AND skey=? ORDER BY ts DESC LIMIT 1`, source, skey).Scan(&ts, &v)
	if err != nil {
		return 0, 0, false
	}
	return ts, v, true
}

// ---- query API ----

type queryReq struct {
	Series string  `json:"series"` // exact series key (name|k=v,..) — raw values
	Base   string  `json:"base"`   // base metric name for a derived stat
	Stat   string  `json:"stat"`   // gauge|total|rate|p50|p95|mean|invmean|ratio
	Combo  string  `json:"combo"`  // partial label filter: k=v,k2=v2
	Denom  string  `json:"denom"`  // denominator base for 'ratio'
	Source string  `json:"source"` // vllm|host|both
	Start  int64   `json:"start"`  // unix ms
	End    int64   `json:"end"`    // unix ms
	Step   int64   `json:"step"`   // bucket seconds (0 = server picks)
}

type point struct {
	T int64   `json:"t"`
	V float64 `json:"v"`
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func sourcesFor(s string) []string {
	switch s {
	case "host":
		return []string{"host"}
	case "both":
		return []string{"vllm", "host"}
	default:
		return []string{"vllm"}
	}
}

func hQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]interface{}{"ok": false, "error": "POST required"})
		return
	}
	var req queryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		(req.Series == "" && req.Base == "") ||
		req.Start <= 0 || req.End < req.Start {
		writeJSON(w, 400, map[string]interface{}{"ok": false, "error": "bad request"})
		return
	}
	if req.End > time.Now().UnixMilli()+60_000 {
		req.End = time.Now().UnixMilli()
	}
	spanMs := req.End - req.Start

	// pick a bucket width: honor the request (>=1s), cap total points at 4000
	buckets := int64(0)
	if req.Step > 0 {
		buckets = spanMs / 1000 / int64(req.Step)
	}
	if buckets > 4000 || buckets == 0 {
		buckets = 4000
		if buckets > spanMs/1000 {
			buckets = spanMs / 1000
		}
		if buckets < 1 {
			buckets = 1
		}
	}
	bucketMs := spanMs / buckets

	pts := queryBuckets(req, bucketMs)
	writeJSON(w, 200, map[string]interface{}{"ok": true, "points": pts})
}

// samplePoint holds one stored row for a series.
type samplePoint struct {
	ts  int64
	val float64
}

// loadSeries loads the stored rows for a set of metric line names across a
// range, grouped by series key and sorted by ts per key.
func loadSeries(nameSet map[string]bool, source string, from, to int64) map[string][]samplePoint {
	out := map[string][]samplePoint{}
	if len(nameSet) == 0 {
		return out
	}
	names := make([]string, 0, len(nameSet))
	for n := range nameSet {
		names = append(names, n)
	}
	q := `SELECT skey, ts, value FROM samples WHERE source=? AND ts BETWEEN ? AND ? AND name IN (` +
		strings.Repeat("?,", len(names)-1) + `?)`
	args := []interface{}{source, from, to}
	for _, n := range names {
		args = append(args, n)
	}
	rows, err := db.Query(q, args...)
	if err != nil {
		log.Printf("retainer: query load: %v", err)
		return nil
	}
	defer rows.Close()
	for rows.Next() {
		var skey string
		var ts int64
		var v float64
		rows.Scan(&skey, &ts, &v)
		out[skey] = append(out[skey], samplePoint{ts, v})
	}
	return out
}

// valueAtOrBefore returns the last stored value at or before ts for a series
// (forward-fill), or nil if no value exists yet.
func valueAtOrBefore(sp []samplePoint, ts int64) *float64 {
	// sp is sorted ascending by ts
	idx := sort.Search(len(sp), func(i int) bool { return sp[i].ts > ts }) - 1
	if idx < 0 {
		return nil
	}
	v := sp[idx].val
	return &v
}

// comboSumAt sums, over all series of a base whose label combo matches,
// the forward-filled value at ts.
func comboSumAt(bySkey map[string][]samplePoint, base, combo string, ts int64) (float64, bool) {
	var total float64
	found := false
	for skey, sp := range bySkey {
		if nameOf(skey) != base {
			continue
		}
		if !matchCombo(skey, combo) {
			continue
		}
		if v := valueAtOrBefore(sp, ts); v != nil {
			total += *v
			found = true
		}
	}
	return total, found
}

// ---- derived-stats query engine ----

func queryBuckets(req queryReq, bucketMs int64) []point {
	var pts []point
	switch {
	case req.Series != "":
		pts = queryRaw(req, bucketMs)
	case req.Stat == "gauge" || req.Stat == "total":
		pts = queryGauge(req, bucketMs)
	case req.Stat == "rate":
		pts = queryDelta(req, bucketMs, func(bySkey map[string][]samplePoint, base, combo string, t0, t1 int64) (float64, bool) {
			c, _ := comboSumAt(bySkey, base, req.Combo, t0)
			n, _ := comboSumAt(bySkey, base, req.Combo, t1)
			dt := float64(t1-t0) / 1000.0
			if dt <= 0 {
				return 0, false
			}
			if c > 0 || n > 0 {
				d := n - c
				if d < 0 {
					d = n // counter reset guard
				}
				return d / dt, true
			}
			return 0, false
		})
	case req.Stat == "p50" || req.Stat == "p95":
		pts = queryPct(req, bucketMs, req.Stat == "p95")
	case req.Stat == "mean" || req.Stat == "invmean":
		pts = queryMean(req, bucketMs, req.Stat == "invmean")
	case req.Stat == "ratio":
		pts = queryDelta(req, bucketMs, func(bySkey map[string][]samplePoint, base, combo string, t0, t1 int64) (float64, bool) {
			if req.Denom == "" {
				return 0, false
			}
			cN, _ := comboSumAt(bySkey, req.Base, req.Combo, t0)
			nN, _ := comboSumAt(bySkey, req.Base, req.Combo, t1)
			cD, _ := comboSumAt(bySkey, req.Denom, req.Combo, t0)
			nD, _ := comboSumAt(bySkey, req.Denom, req.Combo, t1)
			dD := nD - cD
			if dD < 0 {
				dD = nD
			}
			if dD <= 0 {
				if nD > 0 {
					return nN / nD, true // all-time ratio fallback
				}
				return 0, false
			}
			if dD > 0 {
				dN := nN - cN
				if dN < 0 {
					dN = nN
				}
				return dN / dD, true
			}
			return 0, false
		})
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	return pts
}

func nameSetFor(req queryReq) map[string]bool {
	set := map[string]bool{}
	switch req.Stat {
	case "gauge", "total", "rate":
		set[req.Base] = true
	case "p50", "p95":
		set[req.Base+"_bucket"] = true
	case "mean", "invmean":
		set[req.Base+"_sum"] = true
		set[req.Base+"_count"] = true
	case "ratio":
		set[req.Base] = true
		if req.Denom != "" {
			set[req.Denom] = true
		}
	}
	return set
}

// queryGauge returns the forward-filled combo sum at each bucket center.
func queryGauge(req queryReq, bucketMs int64) []point {
	names := map[string]bool{req.Base: true}
	var out []point
	n := int64(req.End - req.Start) / bucketMs
	for _, s := range sourcesFor(req.Source) {
		bySkey := loadSeries(names, s, req.Start-7*60000, req.End)
		for i := int64(0); i < n; i++ {
			center := req.Start + i*bucketMs
			v, ok := comboSumAt(bySkey, req.Base, req.Combo, center)
			if ok {
				out = append(out, point{center, v})
			}
		}
	}
	return out
}

func queryRaw(req queryReq, bucketMs int64) []point {
	var out []point
	for _, s := range sourcesFor(req.Source) {
		rows, err := db.Query(`SELECT ts, value FROM samples WHERE source=? AND skey=? AND ts BETWEEN ? AND ? ORDER BY ts`,
			s, req.Series, req.Start-7*60000, req.End)
		if err != nil {
			continue
		}
		var all []samplePoint
		for rows.Next() {
			var ts int64
			var v float64
			rows.Scan(&ts, &v)
			all = append(all, samplePoint{ts, v})
		}
		rows.Close()
		n := int64(req.End - req.Start) / bucketMs
		for i := int64(0); i < n; i++ {
			center := req.Start + i*bucketMs
			if v := valueAtOrBefore(all, center); v != nil {
				out = append(out, point{center, *v})
			}
		}
	}
	return out
}

// queryDelta buckets each stat into the value of `f(bySkey, base, combo, t0, t1)`,
// where t0..t1 is one bucket span.
func queryDelta(req queryReq, bucketMs int64, f func(m map[string][]samplePoint, base, combo string, t0, t1 int64) (float64, bool)) []point {
	names := nameSetFor(req)
	var out []point
	n := int64(req.End - req.Start) / bucketMs
	for _, s := range sourcesFor(req.Source) {
		bySkey := loadSeries(names, s, req.Start/60000*60000-7*60000, req.End)
		for i := int64(0); i < n; i++ {
			t0 := req.Start + i*bucketMs
			t1 := t0 + bucketMs
			v, ok := f(bySkey, req.Base, req.Combo, t0, t1)
			if ok {
				out = append(out, point{t1, v})
			}
		}
	}
	return out
}

func queryPct(req queryReq, bucketMs int64, p95 bool) []point {
	names := map[string]bool{req.Base + "_bucket": true}
	p := 0.5
	if p95 {
		p = 0.95
	}
	var out []point
	n := int64(req.End - req.Start) / bucketMs
	for _, s := range sourcesFor(req.Source) {
		bySkey := loadSeries(names, s, req.Start/60000*60000-7*60000, req.End)
		for i := int64(0); i < n; i++ {
			t := req.Start + i*bucketMs
			v, ok := pctAt(bySkey, req.Base, req.Combo, p, t)
			if ok {
				out = append(out, point{t, v})
			}
		}
	}
	return out
}

// pctAt computes the cross-combo weighted percentile of the histogram base
// at a single time point from the forward-filled buckets.
func pctAt(bySkey map[string][]samplePoint, base, combo string, p float64, ts int64) (float64, bool) {
	type lePair struct{ le float64; count float64 }
	groups := map[string][]lePair{}
	totals := map[string]float64{} // per-combo total (+Inf) count
	for skey, sp := range bySkey {
		if nameOf(skey) != base+"_bucket" {
			continue
		}
		lbls := labelsOf(skey)
		leStr, ok := lbls["le"]
		if !ok {
			continue
		}
		if !matchCombo(skey, combo) {
			continue
		}
		gk := stripLe(skey)
		v := valueAtOrBefore(sp, ts)
		if v == nil {
			continue
		}
		if leStr == "+Inf" || leStr == "Inf" {
			totals[gk] = *v
			continue
		}
		lf, err := strconv.ParseFloat(leStr, 64)
		if err != nil {
			continue
		}
		groups[gk] = append(groups[gk], lePair{le: lf, count: *v})
	}
	type comboPct struct{ count, pct float64 }
	var out []comboPct
	for gk, g := range groups {
		sort.Slice(g, func(i, j int) bool { return g[i].le < g[j].le })
		total := totals[gk]
		if total <= 0 {
			for _, b := range g {
				if b.count > total {
					total = b.count
				}
			}
		}
		if total <= 0 {
			continue
		}
		target := total * p
		var prevLe, prevC float64
		for _, b := range g {
			if b.count >= target {
				if b.count-prevC <= 0 {
					out = append(out, comboPct{count: total, pct: b.le})
					break
				}
				out = append(out, comboPct{count: total, pct: prevLe + ((target-prevC)/(b.count-prevC))*(b.le-prevLe)})
				break
			}
			prevLe, prevC = b.le, b.count
		}
	}
	if len(out) == 0 {
		return 0, false
	}
	var weight float64
	for _, c := range out {
		weight += c.count
	}
	if weight <= 0 {
		var sum float64
		for _, c := range out {
			sum += c.pct
		}
		return sum / float64(len(out)), true
	}
	var wsum float64
	for _, c := range out {
		wsum += c.pct * c.count
	}
	return wsum / weight, true
}

func queryMean(req queryReq, bucketMs int64, invMean bool) []point {
	names := map[string]bool{req.Base + "_sum": true, req.Base + "_count": true}
	var out []point
	n := int64(req.End - req.Start) / bucketMs
	for _, s := range sourcesFor(req.Source) {
		bySkey := loadSeries(names, s, req.Start/60000*60000, req.End)
		for i := int64(0); i < n; i++ {
			t0 := req.Start + i*bucketMs
			t1 := t0 + bucketMs
			v, ok := meanAt(bySkey, req.Base, req.Combo, t0, t1)
			if ok {
				if invMean && v > 0 {
					v = 1 / v
				}
				out = append(out, point{t1, v})
			}
		}
	}
	return out
}

// meanAt computes Δsum/Δcount across t0..t1 (forward-filled, reset-guarded),
// falling back to the all-time mean when no new observations landed.
func meanAt(bySkey map[string][]samplePoint, base, combo string, t0, t1 int64) (float64, bool) {
	var cS, nS, cC, nC float64
	var found bool
	for skey, sp := range bySkey {
		name := nameOf(skey)
		if !matchCombo(skey, combo) {
			continue
		}
		if name == base+"_sum" {
			if a := valueAtOrBefore(sp, t0); a != nil {
				cS += *a
			}
			if b := valueAtOrBefore(sp, t1); b != nil {
				nS += *b
				found = true
			}
		} else if name == base+"_count" {
			if a := valueAtOrBefore(sp, t0); a != nil {
				cC += *a
			}
			if b := valueAtOrBefore(sp, t1); b != nil {
				nC += *b
				found = true
			}
		}
	}
	if !found {
		return 0, false
	}
	dC := nC - cC
	if dC <= 0 {
		if nC > 0 {
			return nS / nC, true // all-time mean fallback
		}
		return 0, false
	}
	dS := nS - cS
	if dS < 0 {
		dS = nS
	}
	return dS / dC, true
}

func main() {
	cfg = loadConfig()
	if err := dbOpen(); err != nil {
		log.Fatalf("retainer db: %v", err)
	}
	log.Printf("retainer: history db ready at %s (retention %d days)", cfg.DBPath, cfg.RetentionDays)
	pruneRetention()
	go func() {
		for {
			time.Sleep(24 * time.Hour)
			pruneRetention()
		}
	}()
	go func() {
		ticker := time.Tick(time.Duration(cfg.IntervalSec) * time.Second)
		for range ticker {
			scrapeOnce()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]interface{}{"ok": true})
	})
	mux.HandleFunc("/api/history/query", hQuery)
	mux.HandleFunc("/api/history/series", hSeries)
	log.Printf("retainer listening on http://%s (vllm %s | host %s | every %ds)", cfg.Addr, cfg.VLLMURL, cfg.HostURL, cfg.IntervalSec)
	log.Fatal(http.ListenAndServe(cfg.Addr, mux))
}

// hSeries lists the distinct series (name|labels) present in a time range —
// used by the frontend's history explorer to let the user pick a series.
func hSeries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	source := q.Get("source")
	if source == "" {
		source = "both"
	}
	srcs := sourcesFor(source)
	from := int64(0)
	if v := q.Get("from"); v != "" {
		from, _ = strconv.ParseInt(v, 10, 64)
	}
	if from == 0 {
		from = time.Now().Add(-time.Duration(cfg.RetentionDays) * 24 * time.Hour).UnixMilli()
	}
	to := time.Now().UnixMilli()
	if v := q.Get("to"); v != "" {
		to, _ = strconv.ParseInt(v, 10, 64)
	}
	seen := map[string]bool{}
	var out []string
	for _, s := range srcs {
		rows, err := db.Query(`SELECT DISTINCT skey FROM samples WHERE source=? AND ts BETWEEN ? AND ? ORDER BY skey`, s, from, to)
		if err != nil {
			continue
		}
		for rows.Next() {
			var k string
			rows.Scan(&k)
			if !seen[k] {
				seen[k] = true
				out = append(out, k)
			}
		}
		rows.Close()
	}
	writeJSON(w, 200, map[string]interface{}{"ok": true, "series": out})
}
