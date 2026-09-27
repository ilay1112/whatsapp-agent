package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const pairingTestToken = "supersecrettoken1234567890abcdef"

func doAuthedGET(t *testing.T, handler http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080"+path, nil)
	req.Header.Set("Authorization", "Bearer "+pairingTestToken)
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	return resp
}

// TestPairingStatusHandler_DefaultsToConnecting pins down the zero-value
// state a freshly-started process reports before GetQRChannel has produced
// its first "code" event -- the dashboard's onboarding view should show a
// brief "starting up" state rather than erroring on an unrecognized status.
func TestPairingStatusHandler_DefaultsToConnecting(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	resp := doAuthedGET(t, handler, "/api/pairing/status")
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if body["status"] != "connecting" {
		t.Fatalf("expected status=connecting, got %v", body["status"])
	}
	if _, present := body["qr_present"]; present {
		t.Fatalf("expected no qr_present field before any QR code is set, got %v", body)
	}
}

// TestPairingStatusHandler_QRPendingExposesCode is the core contract this
// ticket depends on: once whatsmeow emits a "code" event, the dashboard's
// polling browser UI must see status=qr_pending plus enough of a signal
// (qr_present + expires_at) to know to fetch /api/pairing/qr.png.
func TestPairingStatusHandler_QRPendingExposesCode(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	pairingState.setQRCode("2@fake-qr-payload-data,abc123==,def456==")
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	resp := doAuthedGET(t, handler, "/api/pairing/status")
	var body map[string]interface{}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if body["status"] != "qr_pending" {
		t.Fatalf("expected status=qr_pending, got %v", body["status"])
	}
	if body["qr_present"] != true {
		t.Fatalf("expected qr_present=true, got %v", body["qr_present"])
	}
	if _, ok := body["expires_at"]; !ok {
		t.Fatalf("expected expires_at to be present, got %v", body)
	}
}

// TestPairingQRHandler_404sWithNoCode covers the frontend's poll contract:
// it must be able to tell "no code yet" apart from "here's an image" so it
// doesn't render a broken/blank <img>.
func TestPairingQRHandler_404sWithNoCode(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	resp := doAuthedGET(t, handler, "/api/pairing/qr.png")
	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 with no QR code set, got %d", resp.Code)
	}
}

// TestPairingQRHandler_ServesValidPNG asserts the actual "hard part" of this
// ticket: the live QR payload string renders to real PNG bytes the browser
// can display in an <img> tag, using rsc.io/qr (already vetted -- see
// pairing_status.go) rather than a hand-rolled encoder.
func TestPairingQRHandler_ServesValidPNG(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	pairingState.setQRCode("2@fake-qr-payload-data,abc123==,def456==")
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	resp := doAuthedGET(t, handler, "/api/pairing/qr.png")
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	if ct := resp.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("expected Content-Type image/png, got %q", ct)
	}
	pngMagic := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
	if !bytes.HasPrefix(resp.Body.Bytes(), pngMagic) {
		t.Fatalf("response body does not start with the PNG magic bytes")
	}
	if resp.Body.Len() < 100 {
		t.Fatalf("expected a substantial PNG payload, got only %d bytes", resp.Body.Len())
	}
}

// TestPairingStatusHandler_ConnectedClearsQR asserts the transition the
// dashboard's onboarding view actually watches for: once setConnected() is
// called (fresh pair success, or an already-paired process just reconnecting
// on startup), status flips to "connected" and the QR endpoint stops serving
// a (now stale/meaningless) image.
func TestPairingStatusHandler_ConnectedClearsQR(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	pairingState.setQRCode("2@fake-qr-payload-data,abc123==,def456==")
	pairingState.setConnected()
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	statusResp := doAuthedGET(t, handler, "/api/pairing/status")
	var body map[string]interface{}
	if err := json.Unmarshal(statusResp.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode body: %v", err)
	}
	if body["status"] != "connected" {
		t.Fatalf("expected status=connected, got %v", body["status"])
	}

	qrResp := doAuthedGET(t, handler, "/api/pairing/qr.png")
	if qrResp.Code != http.StatusNotFound {
		t.Fatalf("expected qr.png to 404 once connected, got %d", qrResp.Code)
	}
}

// TestPairingStatusHandler_RequiresAuth asserts the new endpoints go through
// the same bearer-token + loopback-only auth wrapper as every other route on
// this mux (see auth.go) -- pairing state is sensitive (it briefly carries a
// live, scannable link-device credential) and must not be exposed
// unauthenticated even on loopback.
func TestPairingStatusHandler_RequiresAuth(t *testing.T) {
	pairingState = &pairingStateT{phase: pairingPhaseConnecting}
	handler := newRESTMux(newTestClient(&mockLIDStore{}), newTestMessageStore(t), 8080, pairingTestToken, nil)

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/pairing/status", nil)
	// No Authorization header.
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	if resp.Code == http.StatusOK {
		t.Fatalf("expected an unauthenticated request to be rejected, got 200")
	}
}
