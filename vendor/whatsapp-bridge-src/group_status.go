package main

// group_status.go: read-only ("announcement-only") group detection, TKT-API-3.
//
// WhatsApp lets a group be configured so only admins can post -- whatsmeow
// calls this "announce" (types.GroupAnnounce.IsAnnounce). Without exposing
// this, the dashboard offered a live reply composer on every group even when
// this account can't actually post there -- a confusing dead end (type a
// reply, hit send, nothing happens or it silently fails). This file surfaces
// (a) whether a chat is an announce-only group at all, and (b) whether this
// account is currently an admin/super-admin of it (admins can still post in
// an announce group).
//
// Deliberately NOT cached in messages.db: group admin lists and announce
// settings can change at any time (an admin can flip the setting, promote/
// demote members), and caching a stale "you can send here" would be worse
// than a live lookup costing a few hundred ms on chat-open.

import (
	"context"
	"fmt"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// groupInfoTimeout bounds the live GetGroupInfo call -- flagged by
// security-validator's TKT-API-3 review: the original context.Background()
// had no deadline, so a hung request could block a handler goroutine
// indefinitely. 10s matches this codebase's other outbound-call timeouts
// (see the dashboard's app/bridge.py health_check()).
const groupInfoTimeout = 10 * time.Second

// groupSendability reports whether jidStr can currently be sent to by this
// account. Non-group jids (1:1 chats) are always sendable -- this only ever
// restricts announce-only groups where this account isn't an admin.
// isGroup is returned separately from canSend so callers can distinguish
// "not a group, trivially sendable" from "a group, sendable because it's not
// announce-only (or because this account IS an admin)".
func groupSendability(client *whatsmeow.Client, jidStr string) (isGroup bool, canSend bool, isAnnounce bool, err error) {
	jid, parseErr := types.ParseJID(jidStr)
	if parseErr != nil {
		return false, false, false, parseErr
	}
	if jid.Server != types.GroupServer {
		return false, true, false, nil
	}
	isGroup = true

	ctx, cancel := context.WithTimeout(context.Background(), groupInfoTimeout)
	defer cancel()
	info, infoErr := client.GetGroupInfo(ctx, jid)
	if infoErr != nil {
		// Fail OPEN on lookup errors (network hiccup, transient bridge
		// issue, or this timeout firing) -- don't silently disable a chat's
		// composer over a transient error. The /api/send call itself
		// remains the authoritative check, and WhatsApp will reject a
		// genuinely blocked send regardless of what this best-effort check
		// said. Logged (not silent) per security-validator's TKT-API-3
		// review, purely for observability -- this branch grants no new
		// capability on its own.
		fmt.Printf("⚠️  groupSendability: GetGroupInfo(%s) failed, failing open: %v\n", jidStr, infoErr)
		return true, true, false, infoErr
	}
	if !info.IsAnnounce {
		return true, true, false, nil
	}

	if client.Store.ID == nil {
		return true, false, true, nil
	}
	myJID := client.Store.ID.ToNonAD()
	for _, p := range info.Participants {
		if p.JID.ToNonAD() == myJID {
			return true, p.IsAdmin || p.IsSuperAdmin, true, nil
		}
	}
	// This account isn't in the participant list at all (stale membership,
	// just joined, etc.) -- fail CLOSED for an announce group: we can't
	// confirm admin status, so treat as not-sendable rather than suggest a
	// send that WhatsApp will reject.
	fmt.Printf("⚠️  groupSendability: this account not found in %s's participant list, failing closed\n", jidStr)
	return true, false, true, nil
}
