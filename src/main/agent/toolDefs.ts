// src/main/agent/toolDefs.ts   (compile-time constants; I4 purity test asserts byte-identical output for any untrusted input)
import type { LlmTool } from '../llm/types';
import type { JsonSchemaLcd } from '../../shared/types';
import type { McpToolName } from '../mcp/readClient';

/** READ allowlist: the ONLY names ToolGate will ever execute for a model. [R2] `list_events` (calendar titles to the model) is cut from v1:
 *  free/busy is enough for drafting and it was the only tool that could ship event titles to a cloud provider. */
export const READ_TOOL_NAMES = ['get_current_time', 'get_freebusy'] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['timeMin', 'timeMax'],
  properties: {
    timeMin: { type: 'string', description: 'Local start, format YYYY-MM-DDTHH:mm:ss' },
    timeMax: { type: 'string', description: 'Local end, format YYYY-MM-DDTHH:mm:ss, at most 14 days after timeMin' },
  },
} as const satisfies JsonSchemaLcd;
const EMPTY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
} as const satisfies JsonSchemaLcd;

export interface ReadToolSpec {
  def: LlmTool;
  mcpTool: McpToolName;
  maxCallsPerRun: number;
}
export const READ_TOOLS: Record<ReadToolName, ReadToolSpec> = {
  get_current_time: {
    mcpTool: 'get-current-time',
    maxCallsPerRun: 1,
    def: {
      name: 'get_current_time',
      description: "Returns the current date, time and time zone of the user's calendar.",
      inputSchema: EMPTY_SCHEMA,
    },
  },
  get_freebusy: {
    mcpTool: 'get-freebusy',
    maxCallsPerRun: 3,
    def: {
      name: 'get_freebusy',
      description: 'Returns the busy time blocks of the user between timeMin and timeMax. No event details.',
      inputSchema: WINDOW_SCHEMA,
    },
  },
};
