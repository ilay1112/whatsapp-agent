package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const mediaTestToken = "media-test-token-1234567890abcdef"

// insertMediaRow inserts a minimal messages row with just enough fields for
// downloadMedia's own SELECT to find a "cached, ready to serve" media
// message: media_type set, timestamp set, and everything else left at its
// zero value (downloadMedia's cache-hit branch -- the file already exists
// on disk -- returns before it ever needs url/media_key/etc.).
func insertMediaRow(t *testing.T, ms *MessageStore, id, chatJID, mediaType string, ts time.Time) {
	t.Helper()
	_, err := ms.db.Exec(
		`INSERT INTO chats (jid, name) VALUES (?, ?)`,
		chatJID, "test chat",
	)
	if err != nil {
		t.Fatalf("insert chat: %v", err)
	}
	// url/media_key/file_sha256/file_enc_sha256/file_length must be
	// non-NULL (even if zero-value) to match production rows -- real rows
	// always populate these via StoreMediaInfo/extractMediaInfo, and
	// downloadMedia's SELECT Scans them into non-nullable Go types.
	_, err = ms.db.Exec(
		`INSERT INTO messages (id, chat_jid, sender, content, timestamp, is_from_me, media_type, url, media_key, file_sha256, file_enc_sha256, file_length)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, chatJID, chatJID, "", ts, false, mediaType, "", []byte{}, []byte{}, []byte{}, 0,
	)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
}

// writeCachedMediaFile drops a file at exactly the path downloadMedia's
// cache-hit branch expects to find (mirrors main.go's own filename
// construction: "<mediaType>_<timestamp>_<messageID><ext>" inside
// "store/<chatJID with ':' -> '_'>/"), so the test exercises the real
// cache-hit code path rather than a mock.
func writeCachedMediaFile(t *testing.T, chatJID, mediaType, messageID string, ts time.Time, ext string, content []byte) string {
	t.Helper()
	chatDir := "store/" + strings.ReplaceAll(chatJID, ":", "_")
	if err := os.MkdirAll(chatDir, 0o755); err != nil {
		t.Fatalf("mkdir chatDir: %v", err)
	}
	filename := mediaType + "_" + ts.Format("20060102_150405") + "_" + messageID + ext
	path := chatDir + "/" + filename
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write cached file: %v", err)
	}
	return path
}

func mediaGETRequest(jid, messageID string) *http.Request {
	q := url.Values{}
	if jid != "" {
		q.Set("jid", jid)
	}
	if messageID != "" {
		q.Set("message_id", messageID)
	}
	return httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/api/media?"+q.Encode(), nil)
}

func doMediaRequest(t *testing.T, handler http.Handler, req *http.Request, withAuth bool) *httptest.ResponseRecorder {
	t.Helper()
	if withAuth {
		req.Header.Set("Authorization", "Bearer "+mediaTestToken)
	}
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	return resp
}

// TestMediaServeHandler_CacheHitServesRealBytesAndSkipsRedownload is the
// core contract: a media message whose file is already on disk (the common
// case -- the bridge auto-downloads media on receipt, main.go:1636-1674)
// is served without ever needing a live WhatsApp connection or calling
// client.Download -- newTestClient's Store has no working transport, so if
// this test passes, the cache-hit branch was actually taken, not a
// re-download.
func TestMediaServeHandler_CacheHitServesRealBytesAndSkipsRedownload(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	ms := newTestMessageStore(t)
	chatJID := "972501234567@s.whatsapp.net"
	messageID := "AC746A2E81D2CDC0FB3D1C247917B076"
	ts := time.Date(2026, 7, 9, 17, 34, 10, 0, time.UTC)
	insertMediaRow(t, ms, messageID, chatJID, "image", ts)
	want := []byte("\xff\xd8\xff-fake-jpeg-bytes-for-test")
	path := writeCachedMediaFile(t, chatJID, "image", messageID, ts, ".jpg", want)

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest(chatJID, messageID), true)

	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	if ct := resp.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("expected Content-Type image/jpeg, got %q", ct)
	}
	if resp.Body.String() != string(want) {
		t.Fatalf("expected served bytes to equal the cached file's real content")
	}
	cd := resp.Header().Get("Content-Disposition")
	if !strings.Contains(cd, `filename="photo.jpg"`) {
		t.Fatalf("expected a clean filename in Content-Disposition, got %q", cd)
	}
	if strings.Contains(cd, messageID) {
		t.Fatalf("Content-Disposition must not leak the internal cache filename (message id), got %q", cd)
	}

	// Confirm the cache-hit path really didn't touch/rewrite the file
	// (downloadMedia's "file already exists" branch returns immediately).
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat cached file: %v", err)
	}
	if info.Size() != int64(len(want)) {
		t.Fatalf("cached file size changed, expected no re-download to have occurred")
	}
}

// TestMediaServeHandler_RejectsPathTraversalMessageID is the ticket's
// explicit ACCEPT criterion: even if a matching DB row exists with a
// crafted, traversal-shaped id, the handler must reject it before ever
// calling downloadMedia (which would otherwise interpolate it into a
// filesystem path -- see this file's top-of-file security note).
func TestMediaServeHandler_RejectsPathTraversalMessageID(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	ms := newTestMessageStore(t)
	chatJID := "972501234567@s.whatsapp.net"
	evilID := "../../../../evil"
	ts := time.Now()
	insertMediaRow(t, ms, evilID, chatJID, "image", ts)
	// Plant a "secret" file outside chatDir that a successful traversal
	// would need to reach via chatDir/../../../../evil-shaped construction.
	if err := os.MkdirAll("secret", 0o755); err != nil {
		t.Fatalf("mkdir secret: %v", err)
	}
	if err := os.WriteFile("secret/topsecret.txt", []byte("should never be served"), 0o644); err != nil {
		t.Fatalf("write secret file: %v", err)
	}

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest(chatJID, evilID), true)

	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a path-traversal-shaped message_id even with a matching DB row, got %d: %s", resp.Code, resp.Body.String())
	}
	if strings.Contains(resp.Body.String(), "should never be served") {
		t.Fatalf("handler leaked file contents outside the intended store directory")
	}
}

// TestMediaServeHandler_RejectsPathTraversalJID mirrors the message_id test
// for the jid parameter, which also feeds directly into chatDir
// construction in downloadMedia.
func TestMediaServeHandler_RejectsPathTraversalJID(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	ms := newTestMessageStore(t)

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest("../../../../etc/passwd", "AC746A2E81D2CDC0FB3D1C247917B076"), true)

	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a path-traversal-shaped jid, got %d: %s", resp.Code, resp.Body.String())
	}
}

// TestMediaServeHandler_404sWhenMessageDoesNotExist covers a well-formed
// but nonexistent (jid, message_id) pair -- the ordinary "not found" case,
// not an attack.
func TestMediaServeHandler_404sWhenMessageDoesNotExist(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	ms := newTestMessageStore(t)

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest("972501234567@s.whatsapp.net", "AC746A2E81D2CDC0FB3D1C247917B076"), true)

	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a nonexistent message, got %d", resp.Code)
	}
}

// TestMediaServeHandler_404sForNonMediaMessage covers a real row that
// simply isn't a media message (media_type empty) -- downloadMedia's own
// "not a media message" error path.
func TestMediaServeHandler_404sForNonMediaMessage(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	ms := newTestMessageStore(t)
	chatJID := "972501234567@s.whatsapp.net"
	messageID := "AC746A2E81D2CDC0FB3D1C247917B076"
	insertMediaRow(t, ms, messageID, chatJID, "", time.Now())

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest(chatJID, messageID), true)

	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for a non-media message, got %d", resp.Code)
	}
}

// TestMediaServeHandler_RequiresAuth asserts /api/media goes through the
// same bearer-token + Host allow-list wrapper as every other route on this
// mux (see auth.go) -- it is reachable from a browser via the dashboard's
// own unauthenticated proxy, so the bridge-side auth check is the one real
// gate on direct bridge access.
func TestMediaServeHandler_RequiresAuth(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	ms := newTestMessageStore(t)

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	resp := doMediaRequest(t, handler, mediaGETRequest("972501234567@s.whatsapp.net", "AC746A2E81D2CDC0FB3D1C247917B076"), false)

	if resp.Code == http.StatusOK {
		t.Fatalf("expected an unauthenticated request to be rejected, got 200")
	}
}

// TestMediaServeHandler_MethodNotAllowed covers the GET-only contract.
func TestMediaServeHandler_MethodNotAllowed(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	ms := newTestMessageStore(t)

	handler := newRESTMux(newTestClient(&mockLIDStore{}), ms, 8080, mediaTestToken, nil)
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/media?jid=972501234567@s.whatsapp.net&message_id=AC746A2E81D2CDC0FB3D1C247917B076", nil)
	resp := doMediaRequest(t, handler, req, true)

	if resp.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.Code)
	}
}

func TestFriendlyMediaFilename(t *testing.T) {
	cases := []struct {
		mediaType, absPath, want string
	}{
		{"image", "store/x/image_20260709_173410_ABC.jpg", "photo.jpg"},
		{"video", "store/x/video_20260709_173410_ABC.mp4", "video.mp4"},
		{"audio", "store/x/audio_20260709_173410_ABC.ogg", "voice-note.ogg"},
		{"sticker", "store/x/sticker_20260709_173410_ABC.webp", "sticker.webp"},
		{"document", "store/x/real-invoice.pdf", "real-invoice.pdf"},
	}
	for _, tc := range cases {
		if got := friendlyMediaFilename(tc.mediaType, tc.absPath); got != tc.want {
			t.Errorf("friendlyMediaFilename(%q, %q) = %q, want %q", tc.mediaType, tc.absPath, got, tc.want)
		}
	}
}

func TestMessageIDPatternRejectsTraversalShapes(t *testing.T) {
	bad := []string{"../evil", "..\\evil", "a/b", "a\\b", "..", "", strings.Repeat("a", 129)}
	for _, id := range bad {
		if messageIDPattern.MatchString(id) {
			t.Errorf("messageIDPattern unexpectedly accepted %q", id)
		}
	}
	good := []string{"AC746A2E81D2CDC0FB3D1C247917B076", "3A82663FC92B331B8A07"}
	for _, id := range good {
		if !messageIDPattern.MatchString(id) {
			t.Errorf("messageIDPattern unexpectedly rejected real-shaped id %q", id)
		}
	}
}

func TestJIDPatternRejectsTraversalShapes(t *testing.T) {
	bad := []string{"../../etc/passwd", "a/b@s.whatsapp.net", "no-at-sign", ""}
	for _, j := range bad {
		if jidPattern.MatchString(j) {
			t.Errorf("jidPattern unexpectedly accepted %q", j)
		}
	}
	good := []string{"972501234567@s.whatsapp.net", "120363000000000001@g.us"}
	for _, j := range good {
		if !jidPattern.MatchString(j) {
			t.Errorf("jidPattern unexpectedly rejected real-shaped jid %q", j)
		}
	}
}
