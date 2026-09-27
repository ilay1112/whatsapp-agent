package main

// group_participant_count.go: read-only group size lookup, for the
// scheduled calendar-scan task's "skip groups over N participants" rule.
// Separate from group_status.go's groupSendability (which answers "can I
// post here") -- this answers a different question ("how big is this
// group") and has its own caller (the calendar scan, not the composer),
// so it's its own small function rather than a 5th return value bolted
// onto groupSendability.

import (
	"context"
	"fmt"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// groupParticipantCount reports how many participants jidStr's group has.
// Non-group jids return isGroup=false, count=0, err=nil (not an error --
// just not applicable). Uses the same groupInfoTimeout as groupSendability
// (group_status.go) for the live GetGroupInfo call.
func groupParticipantCount(client *whatsmeow.Client, jidStr string) (isGroup bool, count int, err error) {
	jid, parseErr := types.ParseJID(jidStr)
	if parseErr != nil {
		return false, 0, parseErr
	}
	if jid.Server != types.GroupServer {
		return false, 0, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), groupInfoTimeout)
	defer cancel()
	info, infoErr := client.GetGroupInfo(ctx, jid)
	if infoErr != nil {
		fmt.Printf("⚠️  groupParticipantCount: GetGroupInfo(%s) failed: %v\n", jidStr, infoErr)
		return true, 0, infoErr
	}
	return true, len(info.Participants), nil
}
