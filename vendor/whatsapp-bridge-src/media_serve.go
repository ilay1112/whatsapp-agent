package main

// media_serve.go: TKT-API-5 -- streams real media bytes (image/video/voice/
// sticker/document) to the browser. TKT-WEB-7's frontend is already built
// against the dashboard's documented contract `GET
// /api/chat/{jid}/media/{message_id}` (whatsapp-dashboard/static/app.js:1133
// mediaUrl()); this file implements the bridge-side route that dashboard
// route proxies to (see whatsapp-dashboard/app/bridge.py get_media() +
// app/api.py's media route).
//
// Security note (this is the property TKT-API-5's ACCEPT criteria asks to
// be actually verified, not assumed): jid and message_id are used as
// parameterized SQL lookup keys throughout -- downloadMedia (main.go) reads
// the message row via `WHERE id = ? AND chat_jid = ?`, standard
// database/sql placeholder binding, never string-concatenated SQL. There is
// no legitimate user-supplied filesystem path anywhere in this design.
//
// BUT: downloadMedia also rebuilds its on-disk *cache* filename by directly
// interpolating the caller-supplied messageID into a path string (see
// main.go's "Rebuild filename from (timestamp, messageID)" comment,
// `fmt.Sprintf("%s_%s_%s%s", mediaType, ts, messageID, ext)`), and builds
// chatDir from the caller-supplied chatJID the same way
// (`fmt.Sprintf("store/%s", strings.ReplaceAll(chatJID, ":", "_"))`).
// Neither of those interpolations is guarded against "../" segments by
// downloadMedia itself -- that function was written for /api/download,
// reached only via an authenticated POST from the MCP server / trusted
// local caller. This route is reachable (albeit still behind withAuth) from
// a browser via the dashboard's *unauthenticated* proxy (same posture as
// /api/onboarding/qr.png -- see that file's security review), so this
// handler validates both jid and message_id against a strict allow-list
// BEFORE ever calling downloadMedia, independent of the DB layer's own
// (real, but not sufficient on its own) protection. The allow-lists below
// were checked against every real value in this machine's own
// store/messages.db, not designed in the abstract: 29,051/29,051 real
// message ids and 471/471 real chat jids match (see TEAM_BOARD.md
// TKT-API-5 HANDOFF for the query used).
import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.mau.fi/whatsmeow"
)

// messageIDPattern accepts only the alphanumeric shape every real WhatsApp
// message id in this store takes (18-32 chars observed; 128 is a generous
// upper bound, not a measured limit). Critically, it has no `/`, `\`, or
// `.` at all, so "../" traversal segments cannot appear in a value that
// passes this check, regardless of what downloadMedia later does with it.
var messageIDPattern = regexp.MustCompile(`^[A-Za-z0-9]{1,128}$`)

// jidPattern accepts the "<user>@<server>" shape every real chat jid in
// this store takes (e.g. "972501234567@s.whatsapp.net",
// "120363...@g.us"). No `/` or `\` are in the allowed charset, so this
// cannot contribute a path-traversal segment either.
var jidPattern = regexp.MustCompile(`^[A-Za-z0-9.\-]{1,100}@[a-z.]{1,40}$`)

// serveMedia handles GET /api/media?jid=&message_id=. It looks up the
// message's stored media info and (if not already cached on disk)
// downloads+decrypts it via the existing downloadMedia(), then streams the
// resulting file back with a correct Content-Type and a
// Content-Disposition carrying a clean, human-facing filename -- not
// downloadMedia's own internal cache filename, which embeds the message id
// and timestamp.
//
// Deliberately calls downloadMedia() directly rather than first calling
// MessageStore.GetMediaInfo() and then downloadMedia() separately:
// downloadMedia already runs the equivalent lookup internally (it needs
// media_type/url/media_key/etc. from the same row to decide whether a
// download is even needed), so doing both would just be two redundant
// SELECTs against the same row for no added safety -- GetMediaInfo's
// SELECT list is a strict subset of downloadMedia's own.
func serveMedia(w http.ResponseWriter, r *http.Request, client *whatsmeow.Client, messageStore *MessageStore) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	jidStr := r.URL.Query().Get("jid")
	messageID := r.URL.Query().Get("message_id")
	if !jidPattern.MatchString(jidStr) || !messageIDPattern.MatchString(messageID) {
		// Same "not found" the caller would see for a well-formed but
		// nonexistent id -- a malformed value is not a useful signal to
		// hand back, and this avoids turning the endpoint into a format
		// oracle for probing.
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}

	success, mediaType, _, absPath, err := downloadMedia(client, messageStore, messageID, jidStr)
	if !success || err != nil {
		fmt.Printf("media_serve: lookup/download failed jid=%s message_id=%s err=%v\n", jidStr, messageID, err)
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}

	f, openErr := os.Open(absPath)
	if openErr != nil {
		fmt.Printf("media_serve: open cached file failed path=%s err=%v\n", absPath, openErr)
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	info, statErr := f.Stat()
	if statErr != nil {
		http.Error(w, "media not found", http.StatusNotFound)
		return
	}

	_, mimeType, _ := classifyMediaPath(absPath)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", friendlyMediaFilename(mediaType, absPath)))
	// Media bytes for a given (jid, message_id) never change once WhatsApp
	// delivers them, so a private, long-lived cache is safe -- unlike the
	// pairing QR (which rotates) this has no "no-store" reason.
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// http.ServeContent (not a bare io.Copy) sets Content-Type from the
	// header we already set (it only sniffs when Content-Type is unset),
	// fills in Content-Length/Last-Modified, and handles conditional/Range
	// requests for free from the stdlib -- not a new feature we built, just
	// the standard way to serve an *os.File in Go. Range support was
	// explicitly scoped as "nice to have, not required" by this ticket;
	// this doesn't add scope, it's simply what the idiomatic stdlib helper
	// does.
	w.Header().Set("Content-Type", mimeType)
	http.ServeContent(w, r, filepath.Base(absPath), info.ModTime(), f)
}

// friendlyMediaFilename builds a clean, human-facing filename for
// Content-Disposition -- deliberately NOT downloadMedia's own internal
// cache filename (e.g. "image_20260709_173410_AC746A2E81D2CDC0FB3D1C24.jpg"),
// which embeds the message id and timestamp. Documents keep their real
// WhatsApp-supplied filename (already sensible -- see extractMediaInfo's
// DocumentMessage.GetFileName() handling); other media types get a generic
// name plus the real file extension.
func friendlyMediaFilename(mediaType, absPath string) string {
	ext := strings.ToLower(filepath.Ext(absPath))
	switch mediaType {
	case "image":
		return "photo" + ext
	case "video":
		return "video" + ext
	case "audio":
		return "voice-note" + ext
	case "sticker":
		return "sticker" + ext
	default:
		return filepath.Base(absPath)
	}
}
