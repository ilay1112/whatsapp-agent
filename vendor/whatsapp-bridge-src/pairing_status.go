package main

// Tracks WhatsApp pairing/onboarding state so the dashboard's browser UI can
// detect "not yet paired" -> "QR shown, waiting for scan" -> "connected"
// without the console-only QR output that used to be the only place this
// information existed (see main.go's pairing loop -- search "Scan this QR
// code" -- for where these setters are called from). startRESTServer's call
// site was moved up in main() (from after connectionSuccess to right after
// the port/bridgeToken are resolved, before the QR/pairing retry loop) so
// this endpoint -- and /api/health -- are reachable for the whole
// "waiting for scan" window, not just once a device is already connected.
//
// The QR image is rendered server-side with rsc.io/qr (already an indirect
// dependency of this module via github.com/mdp/qrterminal, which uses it
// internally to build the ASCII/Unicode block console rendering) rather
// than shipping a second, hand-written QR encoder to the browser. Reusing
// an already-vetted encoder here is far lower risk than hand-rolling/
// vendoring a JS QR generator from scratch -- a subtly wrong encoding would
// produce an image that looks right but doesn't scan -- and it adds zero
// new dependencies (go.mod only needs `rsc.io/qr` promoted from indirect to
// direct; no new module is fetched).
import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"rsc.io/qr"
)

type pairingPhase string

const (
	// pairingPhaseConnecting covers both "just started, resolving a stored
	// session" and "GetQRChannel called but no code event yet" -- brief,
	// typically well under a second either way.
	pairingPhaseConnecting pairingPhase = "connecting"
	pairingPhaseQRPending  pairingPhase = "qr_pending"
	pairingPhaseConnected  pairingPhase = "connected"
	pairingPhaseTimeout    pairingPhase = "timeout"
	pairingPhaseError      pairingPhase = "error"
)

// qrRefreshWindow approximates whatsmeow's QR-rotation interval. It only
// feeds the frontend an expires_at hint for its own refresh/countdown UI --
// the real expiry authority is whatsmeow's own "timeout" event on the QR
// channel, which main.go's pairing loop already handles by calling
// setTimeout() below.
const qrRefreshWindow = 20 * time.Second

type pairingStateT struct {
	mu        sync.RWMutex
	phase     pairingPhase
	qrCode    string
	expiresAt time.Time
	message   string
}

// pairingState is process-wide singleton state, deliberately: this bridge is
// a single-device, single-user, single-process program (see v1 scope note in
// TKT-WEB-1 -- no multi-account support), so there is exactly one pairing
// lifecycle to track per run.
var pairingState = &pairingStateT{phase: pairingPhaseConnecting}

func (p *pairingStateT) setConnecting() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.phase = pairingPhaseConnecting
	p.qrCode, p.message = "", ""
}

func (p *pairingStateT) setQRCode(code string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.phase = pairingPhaseQRPending
	p.qrCode = code
	p.expiresAt = time.Now().Add(qrRefreshWindow)
	p.message = ""
}

func (p *pairingStateT) setConnected() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.phase = pairingPhaseConnected
	p.qrCode, p.message = "", ""
}

func (p *pairingStateT) setTimeout() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.phase = pairingPhaseTimeout
	p.qrCode = ""
	p.message = "QR code expired without being scanned"
}

func (p *pairingStateT) setError(msg string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.phase = pairingPhaseError
	p.qrCode = ""
	p.message = msg
}

func (p *pairingStateT) snapshot() (phase pairingPhase, qrCode string, expiresAt time.Time, message string) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.phase, p.qrCode, p.expiresAt, p.message
}

// pairingStatusHandler always returns 200 -- unlike /api/health (which
// intentionally 503s while disconnected, correct for a liveness probe), a
// caller polling FOR the connecting/qr_pending state mid-onboarding needs a
// plain response it can read the body of every time, not an error to branch
// around.
func pairingStatusHandler(w http.ResponseWriter, r *http.Request) {
	phase, qrCode, expiresAt, message := pairingState.snapshot()
	body := map[string]interface{}{"status": string(phase)}
	if qrCode != "" {
		body["qr_present"] = true
		body["expires_at"] = expiresAt.Unix()
	}
	if message != "" {
		body["message"] = message
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

// pairingQRHandler serves the live QR code as a PNG image. 404s if there is
// no current code (phase isn't qr_pending) so the frontend's poll loop knows
// to keep waiting on /api/pairing/status rather than caching a stale/blank
// image.
func pairingQRHandler(w http.ResponseWriter, r *http.Request) {
	phase, qrCode, _, _ := pairingState.snapshot()
	if phase != pairingPhaseQRPending || qrCode == "" {
		http.Error(w, "no QR code available", http.StatusNotFound)
		return
	}
	code, err := qr.Encode(qrCode, qr.M)
	if err != nil {
		http.Error(w, "failed to render QR code", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	// Never cache: a stale image would show an already-rotated/expired code
	// as if it were still valid.
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(code.PNG())
}
