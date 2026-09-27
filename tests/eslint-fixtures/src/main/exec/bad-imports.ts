// EXPECT no-restricted-imports x2 : exec/** never imports llm/** or agent/**
import { LlmError } from '../llm/types';
import { createToolGate } from '../agent/toolGate';
export const x = [LlmError, createToolGate];
