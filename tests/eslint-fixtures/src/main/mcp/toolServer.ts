// EXPECT no-restricted-imports x8 : the WhatsApp read surface imports no send/read bridge client, mcp write/admin/host, exec, llm, electron
// [V2] named toolServer.ts (not bad-imports.ts) because the boundary is file-specific (build-plan rule 13, T2 group 2 part B).
import { createBridgeSendClient } from '../bridge/sendClient';
import { createBridgeReadClient } from '../bridge/readClient';
import { createMcpWriteClient } from './writeClient';
import { createMcpAdminClient } from './adminClient';
import { createMcpHost } from './host';
import { createActionExecutor } from '../exec/actionExecutor';
import { LlmError } from '../llm/types';
import { app } from 'electron';
export const x = [createBridgeSendClient, createBridgeReadClient, createMcpWriteClient, createMcpAdminClient, createMcpHost, createActionExecutor, LlmError, app];
