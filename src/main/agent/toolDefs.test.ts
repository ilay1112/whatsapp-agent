// CONTRACTS section 18 item 7: Object.keys(MCP_TOOLS).sort() == sorted ENABLED_TOOLS_ENV ; READ_TOOLS[*].mcpTool all have class 'read'.
import { describe, expect, it } from 'vitest';
import { ENABLED_TOOLS_ENV, MCP_TOOLS } from '../mcp/readClient';
import { READ_TOOLS, READ_TOOL_NAMES } from './toolDefs';

describe('tool tables', () => {
  it('MCP_TOOLS keys == ENABLED_TOOLS_ENV names', () => {
    expect(Object.keys(MCP_TOOLS).sort().join(',')).toBe(ENABLED_TOOLS_ENV.split(',').sort().join(','));
  });
  it('every READ tool maps to an MCP tool of class read', () => {
    for (const name of READ_TOOL_NAMES) {
      const spec = READ_TOOLS[name];
      expect(spec.def.name).toBe(name);
      expect(MCP_TOOLS[spec.mcpTool]).toBe('read');
      expect(spec.maxCallsPerRun).toBeGreaterThan(0);
    }
  });
  it('[R2] list_events is not offered to the model and no write/admin tool is reachable by name', () => {
    expect(READ_TOOL_NAMES).toEqual(['get_current_time', 'get_freebusy']);
    const mcpTools = Object.values(READ_TOOLS).map((s) => s.mcpTool);
    expect(mcpTools).not.toContain('create-event');
    expect(mcpTools).not.toContain('list-events');
    expect(mcpTools).not.toContain('manage-accounts');
  });
  it('tool definitions are LCD JSON schema objects with additionalProperties false', () => {
    for (const spec of Object.values(READ_TOOLS)) {
      expect(spec.def.inputSchema.type).toBe('object');
      expect((spec.def.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });

  // TESTS 5.3 row `agent/prompt.ts, toolDefs.ts` + L4 item 4 (I4): the definitions are compile-time app constants,
  // so they can never be influenced by message text, a contact name or a tool result.
  it('uses only the lowest-common-denominator JSON Schema subset (no $ref / anyOf / type arrays / min / max / null)', () => {
    const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description']);
    const walk = (node: unknown, path: string): void => {
      expect(node, path).toBeTypeOf('object');
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        expect(ALLOWED.has(k), `${path}.${k} is outside the LCD subset`).toBe(true);
        expect(v).not.toBeNull();
        if (k === 'type') expect(Array.isArray(v)).toBe(false);
        if (k === 'properties')
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) walk(pv, `${path}.properties.${pk}`);
        if (k === 'items') walk(v, `${path}.items`);
      }
    };
    for (const spec of Object.values(READ_TOOLS)) {
      walk(spec.def.inputSchema, spec.def.name);
      const json = JSON.stringify(spec.def);
      for (const banned of [
        '$ref',
        'anyOf',
        'oneOf',
        'allOf',
        'minLength',
        'maxLength',
        'minimum',
        'maximum',
        'nullable',
        'format',
      ]) {
        expect(json, `${banned} must not be a schema key`).not.toContain(`"${banned}":`);
      }
    }
  });

  it('serialises to the same bytes on every read (nothing per-run, nothing untrusted)', () => {
    const once = JSON.stringify(READ_TOOL_NAMES.map((n) => READ_TOOLS[n].def));
    const twice = JSON.stringify(READ_TOOL_NAMES.map((n) => READ_TOOLS[n].def));
    expect(twice).toBe(once);
    expect(once).toContain('"name":"get_current_time"');
    expect(once).toContain('"name":"get_freebusy"');
  });

  it('keeps the budgets of ARCHITECTURE 5.3 (1 current-time call, 3 free/busy calls per run)', () => {
    expect(READ_TOOLS.get_current_time.maxCallsPerRun).toBe(1);
    expect(READ_TOOLS.get_freebusy.maxCallsPerRun).toBe(3);
    expect(
      Object.keys(
        READ_TOOLS.get_freebusy.def.inputSchema.type === 'object'
          ? READ_TOOLS.get_freebusy.def.inputSchema.properties
          : {},
      ).sort(),
    ).toEqual(['timeMax', 'timeMin']);
  });
});
