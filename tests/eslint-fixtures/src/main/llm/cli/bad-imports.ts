// EXPECT no-restricted-imports x4 : llm/cli/** imports no mcp/host, bridge/**, exec/** (T2 group 2 part D)
import { createMcpHost } from '../../mcp/host';
import { createBridgeReadClient } from '../../bridge/readClient';
import { openBridgeDb } from '../../bridge/bridgeDb';
import { createActionExecutor } from '../../exec/actionExecutor';
export const x = [createMcpHost, createBridgeReadClient, openBridgeDb, createActionExecutor];
