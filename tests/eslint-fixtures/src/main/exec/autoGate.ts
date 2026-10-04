// EXPECT no-restricted-imports x6 : exec/autoGate.ts is pure - no ipc/**, node:fs, node:child_process, electron, agent/**, llm/**
// [V2] named autoGate.ts (not bad-imports.ts) because the boundary is file-specific (build-plan rule 13, T2 group 15 part C).
import { createAutoHandlers } from '../ipc/handlers/auto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { createItemService } from '../agent/items';
import { LlmError } from '../llm/types';
export const x = [createAutoHandlers, readFileSync, spawn, app, createItemService, LlmError];
