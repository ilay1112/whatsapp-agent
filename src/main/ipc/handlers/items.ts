// src/main/ipc/handlers/items.ts - handlers for the channels below (build-plan section 3; owner W1-13). Bodies return Result<T>, never throw.
// No business logic: every card, ChatView and phone display is built by ItemService (W1-10), which is also the only place a JID is read.
import type { IpcHandlers } from '../../../shared/ipc';
import { ok, type HandlerDeps } from '../register';

export type ItemsChannels =
  | 'dashboard:get'
  | 'dashboard:getIgnored'
  | 'item:get'
  | 'item:dismiss'
  | 'item:restore'
  | 'item:retriage'
  | 'item:setEditing'
  | 'item:completeEvent'
  | 'chat:setPolicy'
  | 'chat:listPolicies';

export function createItemsHandlers(deps: HandlerDeps): Pick<IpcHandlers, ItemsChannels> {
  return {
    'dashboard:get': () => ok(deps.items.dashboard()),
    // [R2] "Undo dismiss" drawer: the last 20 items closed with reason 'dismissed', nothing else.
    'dashboard:getIgnored': () => ok(deps.items.ignored()),

    'item:get': (req) => deps.items.detail(req.itemId),
    'item:dismiss': (req) => deps.items.dismiss(req.itemId),
    'item:restore': (req) => deps.items.restore(req.itemId),
    'item:retriage': (req) => deps.items.retriage(req.itemId),
    'item:setEditing': (req) => deps.items.setEditing(req.itemId, req.editing),
    'item:completeEvent': (req) => deps.items.completeEvent(req),

    // chatRef is chats.id - the renderer never sees or sends a JID.
    'chat:setPolicy': (req) => deps.items.setChatPolicy(req),
    'chat:listPolicies': () => ok(deps.items.listPolicies()),
  };
}
