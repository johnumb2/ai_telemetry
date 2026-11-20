// Command hoststats is a tiny, dependency-free Prometheus sidecar.
//
// It exposes host telemetry (CPU, RAM, the AMD GPU via amdgpu sysfs / hwmon,
// NVMe temperatures, uptime and process count) as Prometheus text gauges. It
// reads only /proc and /sys, so it works inside an ordinary (rootless is fine)
// Docker container without any rocm-smi dependency. Missing files are skipped
// silently so a metric only appears when its source is read.
//
// Listen address: environment variable HOSTSTATS_ADDR (default 127.0.0.1:9340).
// The single route is GET /metrics.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// metric is a single gauge sample, optionally with Prometheus labels.
type metric struct {
	Name   string
	Value  float64
	Labels map[string]string
}

var helpText = map[string]string{
	"host_cpu_usage_percent":     "Aggregate CPU usage percentage across all cores",
	"host_cpu_temp_celsius":      "CPU temperature in Celsius",
	"host_cpu_load":              "System load average (period: 1m, 5m, 15m)",
	"host_cpu_cores":             "Number of logical CPU cores",
	"host_ram_total_bytes":       "Total RAM in bytes",
	"host_ram_available_bytes":   "Available RAM in bytes",
	"host_ram_used_percent":      "RAM used percentage",
	"host_swap_total_bytes":      "Total swap in bytes",
	"host_swap_used_percent":     "Swap used percentage",
	"host_uptime_seconds":        "System uptime in seconds",
	"host_process_count":         "Number of running processes",
	"host_gpu_device":            "1 if this GPU is present (card label is the PCI address)",
	"host_gpu_temp_celsius":      "GPU temperature in Celsius (part: edge, junction, memory)",
	"host_gpu_busy_percent":      "GPU compute utilization percentage (amdgpu sysfs)",
	"host_gpu_mem_busy_percent":  "GPU VRAM bandwidth utilization percentage",
	"host_gpu_vram_used_bytes":   "VRAM used in bytes",
	"host_gpu_vram_total_bytes":  "VRAM total in bytes",
	"host_gpu_vram_used_percent": "VRAM used percentage",
	"host_gpu_power_watts":       "GPU power draw in watts",
	"host_gpu_fan_percent":       "GPU fan speed percentage",
	"host_gpu_fan_rpm":           "GPU fan speed in RPM",
	"host_gpu_fan_max_rpm":       "GPU fan maximum speed in RPM",
	"host_nvme_temp_celsius":     "NVMe drive temperature in Celsius",
}

// ---- small file readers (skip on error/empty, never panic) ----

func readStr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readInt(path string) (int64, bool) {
	s := readStr(path)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func readFloat(path string) (float64, bool) {
	s := readStr(path)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ---- /proc ----

func readCPUStat() (total, idle int64, cores int, ok bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0, 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if f[0] == "cpu" {
			var t int64
			for _, tok := range f[1:] {
				if v, err := strconv.ParseInt(tok, 10, 64); err == nil {
					t += v
				}
			}
			if len(f) >= 6 {
				if v, err := strconv.ParseInt(f[4], 10, 64); err == nil {
					idle += v
				}
				if v, err := strconv.ParseInt(f[5], 10, 64); err == nil {
					idle += v
				}
			}
			total = t
			ok = true
			continue
		}
		if strings.HasPrefix(f[0], "cpu") {
			if _, err := strconv.Atoi(f[0][3:]); err == nil {
				cores++
			}
		}
	}
	return total, idle, cores, ok
}

func readLoadAvg() (l1, l5, l15 float64, ok bool) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, false
	}
	f := strings.Fields(string(b))
	if len(f) >= 3 {
		l1, _ = strconv.ParseFloat(f[0], 64)
		l5, _ = strconv.ParseFloat(f[1], 64)
		l15, _ = strconv.ParseFloat(f[2], 64)
		return l1, l5, l15, true
	}
	return 0, 0, 0, false
}

func readMeminfo() (total, avail, swapTotal, swapFree int64, ok bool) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, 0, 0, false
	}
	m := map[string]int64{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			if v, err := strconv.ParseInt(f[1], 10, 64); err == nil {
				m[strings.TrimSuffix(f[0], ":")] = v
			}
		}
	}
	t, _ := m["MemTotal"]
	a, _ := m["MemAvailable"]
	st, _ := m["SwapTotal"]
	sf, _ := m["SwapFree"]
	return t * 1024, a * 1024, st * 1024, sf * 1024, true
}

func readUptime() (float64, bool) {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, false
	}
	f := strings.Fields(string(b))
	if len(f) >= 1 {
		v, err := strconv.ParseFloat(f[0], 64)
		if err != nil {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

func readProcessCount() (int, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() && allDigits(e.Name()) {
			n++
		}
	}
	return n, true
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ---- /sys hwmon + amdgpu sysfs ----

func listHwmon() []string {
	entries, err := os.ReadDir("/sys/class/hwmon")
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		// Entries are normally symlinks into /sys/devices (IsDir() is false
		// for them), so accept every entry, not just directories.
		out = append(out, e.Name())
	}
	return out
}

func hwmonName(path string) string {
	return readStr(filepath.Join(path, "name"))
}

// pciAddrOf resolves the PCI BDF (e.g. 0000:03:00.0) for a sysfs "device"
// symlink path. Returns an empty string when no PCI link exists (an integrated
// APU/iGPU has no BDF).
func pciAddrOf(devSymlink string) string {
	raw, err := os.Readlink(devSymlink)
	if err != nil {
		return ""
	}
	return filepath.Base(raw)
}

func hwmonDevicePCI(path string) string {
	return pciAddrOf(filepath.Join(path, "device"))
}

func readCPUTemp() float64 {
	core := -1.0
	for _, hw := range listHwmon() {
		p := "/sys/class/hwmon/" + hw
		if hwmonName(p) == "k10temp" {
			if v, ok := readFloat(filepath.Join(p, "temp1_input")); ok && v > 0 {
				return v / 1000
			}
		}
		if hwmonName(p) == "coretemp" {
			if v, ok := readFloat(filepath.Join(p, "temp1_input")); ok && v > 0 {
				core = v / 1000
			}
		}
	}
	return core
}

type gpuInfo struct {
	Found        bool
	PCIAddr      string
	BusyPct      float64
	MemBusyPct   float64
	VramUsed     int64
	VramTotal    int64
	EdgeTemp     float64
	JunctionTemp float64
	MemTemp      float64
	PowerWatts   float64
	FanPct       float64
	FanRPM       int64
	FanMaxRPM    int64
}

func readGPU() *gpuInfo {
	dirs, err := filepath.Glob("/sys/class/drm/card*/device")
	if err != nil || len(dirs) == 0 {
		return nil
	}
	type cand struct {
		dev  string
		vram int64
	}
	var cands []cand
	for _, d := range dirs {
		if vt, ok := readInt(filepath.Join(d, "mem_info_vram_total")); ok && vt > 0 {
			cands = append(cands, cand{dev: d, vram: vt})
		}
	}
	if len(cands) == 0 {
		return nil
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].vram > cands[j].vram })
	primary := cands[0]

	info := &gpuInfo{Found: true}
	if v, ok := readInt(filepath.Join(primary.dev, "gpu_busy_percent")); ok {
		info.BusyPct = float64(v)
	}
	if v, ok := readInt(filepath.Join(primary.dev, "mem_busy_percent")); ok {
		info.MemBusyPct = float64(v)
	}
	info.VramTotal = primary.vram
	if v, ok := readInt(filepath.Join(primary.dev, "mem_info_vram_used")); ok {
		info.VramUsed = v
	}
	// The card's own "device" symlink is <card>/device/device. It may resolve
	// to a real PCI BDF (discrete GPU) or be absent (integrated APU/iGPU).
	info.PCIAddr = pciAddrOf(filepath.Join(primary.dev, "device"))
	readGpuHwmon(info)
	return info
}

func readGpuHwmon(info *gpuInfo) {
	// Collect the amdgpu hwmon sensors. Prefer the one whose device resolves
	// to the matched PCI BDF; otherwise (integrated APU or no match) fall back
	// to the first amdgpu hwmon (there is one per GPU).
	var amdgpus []string
	var match string
	for _, hw := range listHwmon() {
		p := "/sys/class/hwmon/" + hw
		if hwmonName(p) != "amdgpu" {
			continue
		}
		amdgpus = append(amdgpus, p)
		if info.PCIAddr != "" && hwmonDevicePCI(p) == info.PCIAddr {
			match = p
		}
	}
	target := match
	if target == "" && len(amdgpus) > 0 {
		target = amdgpus[0]
	}
	if target == "" {
		return
	}
	gpuHwmonRead(info, target)
}

func gpuHwmonRead(info *gpuInfo, p string) {
	if v, ok := readFloat(filepath.Join(p, "temp1_input")); ok && v > 0 {
		info.EdgeTemp = v / 1000
	}
	if v, ok := readFloat(filepath.Join(p, "temp2_input")); ok && v > 0 {
		info.JunctionTemp = v / 1000
	}
	if v, ok := readFloat(filepath.Join(p, "temp3_input")); ok && v > 0 {
		info.MemTemp = v / 1000
	}
	// amdgpu hwmon power1_average is in microWatts (see
	// docs.kernel.org/gpu/amdgpu/thermal.html) — divide by 1e6.
	if v, ok := readInt(filepath.Join(p, "power1_average")); ok && v > 0 {
		info.PowerWatts = float64(v) / 1e6
	}
	pw, okP := readInt(filepath.Join(p, "pwm1"))
	wMax, okMax := readInt(filepath.Join(p, "pwm1_max"))
	wMin, okMin := readInt(filepath.Join(p, "pwm1_min"))
	if okP && okMax && okMin && wMax > wMin {
		info.FanPct = float64(pw-wMin) / float64(wMax-wMin) * 100
	}
	if v, ok := readInt(filepath.Join(p, "fan1_input")); ok && v > 0 {
		info.FanRPM = v
	}
	if v, ok := readInt(filepath.Join(p, "fan1_max")); ok && v > 0 {
		info.FanMaxRPM = v
	}
}

func readNVMeTemps() []struct {
	device  string
	celsius float64
} {
	var out []struct {
		device  string
		celsius float64
	}
	for _, hw := range listHwmon() {
		p := "/sys/class/hwmon/" + hw
		if hwmonName(p) != "nvme" {
			continue
		}
		dev := hwmonDevicePCI(p)
		if v, ok := readFloat(filepath.Join(p, "temp1_input")); ok && v > 0 {
			out = append(out, struct {
				device  string
				celsius float64
			}{dev, v / 1000})
		}
	}
	return out
}

// ---- CPU usage (self-rate between consecutive scrapes) ----

type prevCpu struct {
	total int64
	idle  int64
	ts    time.Time
}

var (
	cpuPrev    prevCpu
	cpuHasPrev bool
	cpuMu      sync.Mutex
)

func cpuUsage() float64 {
	total, idle, _, ok := readCPUStat()
	if !ok {
		return -1
	}
	cpuMu.Lock()
	defer cpuMu.Unlock()
	now := time.Now()
	usage := -1.0
	if cpuHasPrev {
		dt := now.Sub(cpuPrev.ts).Seconds()
		dTotal := total - cpuPrev.total
		dIdle := idle - cpuPrev.idle
		if dt > 0 && dTotal > 0 {
			usage = (float64(dTotal-dIdle) / float64(dTotal)) * 100
			if usage < 0 {
				usage = 0
			}
		}
	}
	cpuPrev = prevCpu{total: total, idle: idle, ts: now}
	cpuHasPrev = true
	return usage
}

// ---- scrape + render ----

func collectMetrics() []metric {
	var out []metric
	add := func(name string, v float64) {
		out = append(out, metric{Name: name, Value: v})
	}
	addL := func(name string, v float64, labels map[string]string) {
		out = append(out, metric{Name: name, Value: v, Labels: labels})
	}

	if u := cpuUsage(); u >= 0 {
		add("host_cpu_usage_percent", float64(u))
	}
	if t := readCPUTemp(); t > 0 {
		add("host_cpu_temp_celsius", t)
	}
	if l1, l5, l15, ok := readLoadAvg(); ok {
		addL("host_cpu_load", l1, map[string]string{"period": "1m"})
		addL("host_cpu_load", l5, map[string]string{"period": "5m"})
		addL("host_cpu_load", l15, map[string]string{"period": "15m"})
	}
	if _, _, cores, ok := readCPUStat(); ok && cores > 0 {
		add("host_cpu_cores", float64(cores))
	}
	if total, avail, swapTotal, swapFree, ok := readMeminfo(); ok {
		if total > 0 {
			add("host_ram_total_bytes", float64(total))
			add("host_ram_available_bytes", float64(avail))
			add("host_ram_used_percent", float64(total-avail)/float64(total)*100)
		}
		if swapTotal > 0 {
			add("host_swap_total_bytes", float64(swapTotal))
			add("host_swap_used_percent", float64(swapTotal-swapFree)/float64(swapTotal)*100)
		}
	}
	if u, ok := readUptime(); ok {
		add("host_uptime_seconds", u)
	}
	if p, ok := readProcessCount(); ok {
		add("host_process_count", float64(p))
	}

	if info := readGPU(); info != nil && info.Found {
		addL("host_gpu_device", 1, map[string]string{"card": info.PCIAddr})
		if info.EdgeTemp > 0 {
			addL("host_gpu_temp_celsius", info.EdgeTemp, map[string]string{"part": "edge"})
		}
		if info.JunctionTemp > 0 {
			addL("host_gpu_temp_celsius", info.JunctionTemp, map[string]string{"part": "junction"})
		}
		if info.MemTemp > 0 {
			addL("host_gpu_temp_celsius", info.MemTemp, map[string]string{"part": "memory"})
		}
		if info.BusyPct >= 0 {
			add("host_gpu_busy_percent", info.BusyPct)
		}
		if info.MemBusyPct >= 0 {
			add("host_gpu_mem_busy_percent", info.MemBusyPct)
		}
		if info.VramUsed > 0 || info.VramTotal > 0 {
			add("host_gpu_vram_used_bytes", float64(info.VramUsed))
			add("host_gpu_vram_total_bytes", float64(info.VramTotal))
			if info.VramTotal > 0 {
				add("host_gpu_vram_used_percent", float64(info.VramUsed)/float64(info.VramTotal)*100)
			}
		}
		if info.PowerWatts > 0 {
			add("host_gpu_power_watts", info.PowerWatts)
		}
		if info.FanPct >= 0 {
			add("host_gpu_fan_percent", info.FanPct)
		}
		if info.FanRPM > 0 {
			add("host_gpu_fan_rpm", float64(info.FanRPM))
			if info.FanMaxRPM > 0 {
				add("host_gpu_fan_max_rpm", float64(info.FanMaxRPM))
			}
		}
	}

	for _, n := range readNVMeTemps() {
		if n.celsius > 0 {
			addL("host_nvme_temp_celsius", n.celsius, map[string]string{"device": n.device})
		}
	}

	return out
}

func labelEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

func labelStr(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, k+"=\""+labelEscape(labels[k])+"\"")
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func metricsHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/metrics" && r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	metrics := collectMetrics()
	var b strings.Builder
	seen := map[string]bool{}
	for _, m := range metrics {
		if !seen[m.Name] {
			seen[m.Name] = true
			help := helpText[m.Name]
			if help == "" {
				help = "host metric"
			}
			b.WriteString("# HELP " + m.Name + " " + help + "\n")
			b.WriteString("# TYPE " + m.Name + " gauge\n")
		}
		l := labelStr(m.Labels)
		b.WriteString(m.Name)
		if l != "" {
			b.WriteString(l)
		}
		b.WriteString(" " + fmt.Sprintf("%.3f", m.Value) + "\n")
	}
	fmt.Fprint(w, b.String())
}

func main() {
	addr := os.Getenv("HOSTSTATS_ADDR")
	if addr == "" {
		addr = "127.0.0.1:9340"
	}
	http.HandleFunc("/metrics", metricsHandler)
	http.HandleFunc("/", metricsHandler)
	log.Printf("hoststats listening on http://%s/metrics", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("hoststats: %v", err)
	}
}
