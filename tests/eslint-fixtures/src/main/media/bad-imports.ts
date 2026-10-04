// EXPECT no-restricted-imports x5 : media/** gets bytes only via media/fetch.ts and nativeImage only via S-IMAGE
import { createBridgeReadClient } from '../bridge/readClient';
import { nativeImage } from 'electron';
import { createActionExecutor } from '../exec/actionExecutor';
import { LlmError } from '../llm/types';
import { createItemService } from '../agent/items';
export const x = [createBridgeReadClient, nativeImage, createActionExecutor, LlmError, createItemService];
