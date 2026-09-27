// EXPECT no-restricted-imports x5 : agent/** never imports exec/**, bridge/sendClient, mcp/writeClient, mcp/adminClient, mcp/host
import { createActionExecutor } from '../exec/actionExecutor';
import { createBridgeSendClient } from '../bridge/sendClient';
import { createMcpWriteClient } from '../mcp/writeClient';
import { createMcpAdminClient } from '../mcp/adminClient';
import { createMcpHost } from '../mcp/host';
export const x = [createActionExecutor, createBridgeSendClient, createMcpWriteClient, createMcpAdminClient, createMcpHost];
