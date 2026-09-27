// EXPECT no-restricted-imports x3 : src/shared imports only zod + shared files (no node:*, no electron, no react)
import fs from 'node:fs';
import { app } from 'electron';
import React from 'react';
export const x = [fs, app, React];
