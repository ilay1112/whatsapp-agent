// eslint.config.js - flat config (W0). Encodes the import boundaries of ARCHITECTURE section 18, the `electron` import allow-list,
// `no-console` in src/main, the innerHTML/dangerouslySetInnerHTML ban, the physical-Tailwind-class ban in src/renderer and the
// non-literal dynamic import() ban in src/main. tests/eslint-fixtures/** proves every rule fires (tests/eslint-fixtures/rules.test.ts).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** Files in src/main that may import `electron` (ARCHITECTURE section 3 / build-plan rule 10). */
const ELECTRON_ALLOWED = [
  'src/main/index.ts',
  'src/main/compose.ts',
  'src/main/app/**/*.ts',
  'src/main/ipc/register.ts',
  'src/main/secrets.ts',
  'src/main/testSeams.ts',
];

const noElectron = {
  name: 'electron',
  message:
    'Only src/main/{index,compose,secrets,testSeams}.ts, src/main/app/** and src/main/ipc/register.ts may import electron.',
};
const noNodeBuiltins = {
  regex: '^node:',
  message: 'src/shared and src/renderer never import node built-ins.',
};

// ---- [V2] build-plan rule 13 (ARCH 18 + ARCH2 15 + C2 19) boundaries. Flat config REPLACES a rule's options when two blocks
// match one file, so every v2 block repeats the v1 patterns of the directory it narrows (agent/llm/exec). ----
const re = (s, message) => ({ regex: s, message });
const AGENT_LLM_V1 = [
  re(String.raw`(^|/)exec(/|$)`, 'agent/** and llm/** never import exec/**.'),
  re(String.raw`(^|/)bridge/sendClient(\.ts)?$`, 'agent/** and llm/** never import bridge/sendClient.'),
  re(String.raw`(^|/)mcp/writeClient(\.ts)?$`, 'agent/** and llm/** never import mcp/writeClient.'),
  re(String.raw`(^|/)mcp/adminClient(\.ts)?$`, 'agent/** and llm/** never import mcp/adminClient.'),
  re(String.raw`(^|/)mcp/host(\.ts)?$`, 'agent/** and llm/** never import mcp/host.'),
];
const EXEC_V1 = [
  re(String.raw`(^|/)llm(/|$)`, 'exec/** never imports llm/**.'),
  re(String.raw`(^|/)agent(/|$)`, 'exec/** never imports agent/**.'),
];
/** exec/autoGate.ts: pure, LLM-free (ARCH2 B8, T2 group 15 part C). */
const AUTOGATE_V2 = [
  re(String.raw`(^|/)ipc(/|$)`, 'exec/autoGate.ts never imports ipc/** (B8: pure).'),
  re('^node:fs(/promises)?$', 'exec/autoGate.ts never imports node:fs (B8: no I/O).'),
  re('^node:child_process$', 'exec/autoGate.ts never imports node:child_process (B8: no I/O).'),
];
/** The WhatsApp read surface (toolServer, waReadClient, waTools, handles): T2 group 2 part B. Relative same-dir forms included. */
const WA_READ_SURFACE_V2 = [
  re(
    String.raw`(^|/)bridge/sendClient(\.ts)?$|^\./sendClient(\.ts)?$`,
    'the WhatsApp read surface never imports bridge/sendClient.',
  ),
  re(
    String.raw`(^|/)bridge/readClient(\.ts)?$|^\./readClient(\.ts)?$`,
    'the WhatsApp read surface never imports bridge/readClient.',
  ),
  re(
    String.raw`(^|/)mcp/writeClient(\.ts)?$|^\./writeClient(\.ts)?$`,
    'the WhatsApp read surface never imports mcp/writeClient.',
  ),
  re(
    String.raw`(^|/)mcp/adminClient(\.ts)?$|^\./adminClient(\.ts)?$`,
    'the WhatsApp read surface never imports mcp/adminClient.',
  ),
  re(String.raw`(^|/)mcp/host(\.ts)?$|^\./host(\.ts)?$`, 'the WhatsApp read surface never imports mcp/host.'),
  re(String.raw`(^|/)exec(/|$)`, 'the WhatsApp read surface never imports exec/**.'),
  re(String.raw`(^|/)llm(/|$)`, 'the WhatsApp read surface never imports llm/**.'),
];
/** llm/cli/**: T2 group 2 part D. */
const LLM_CLI_V2 = [re(String.raw`(^|/)bridge(/|$)`, 'llm/cli/** never imports bridge/**.')];
/** media/**: bytes only through media/fetch.ts (the only getMedia caller, I6'); nativeImage only through S-IMAGE (rule 12).
 *  [W0 interpretation] lint approximates "only media/fetch.ts calls getMedia" by banning bridge/readClient in media/** except fetch.ts. */
const MEDIA_V2 = [
  re(
    String.raw`(^|/)bridge/readClient(\.ts)?$`,
    'only media/fetch.ts may import bridge/readClient (the one getMedia caller).',
  ),
  re(String.raw`(^|/)exec(/|$)`, 'media/** never imports exec/**.'),
  re(String.raw`(^|/)llm(/|$)`, 'media/** never imports llm/**.'),
  re(String.raw`(^|/)agent(/|$)`, 'media/** never imports agent/**.'),
];

/** Physical Tailwind classes are banned in src/renderer (logical utilities only: ms-*, me-*, ps-*, pe-*, start-*, end-*, text-start, text-end). */
const PHYSICAL_CLASS_RE = String.raw`(^|\s)(ml|mr|pl|pr|left|right)-[^\s]+|(^|\s)text-(left|right)(\s|$)`;

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'build-resources/**',
      'vendor/**',
      'resources/**',
      'tests/eslint-fixtures/**',
      'docs/**',
      'ops/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // CONTRACTS blocks use inline `import('./errors').ErrorCode` type annotations verbatim, so they stay allowed.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // CONTRACTS `stripInvisible` matches C0 control characters on purpose.
      'no-control-regex': 'off',
      // Ban innerHTML / outerHTML / insertAdjacentHTML / dangerouslySetInnerHTML everywhere (ARCHITECTURE 15.1).
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned.',
        },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is banned.' },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is banned.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is banned.' },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned.',
        },
      ],
    },
  },
  // ----- src/shared: only zod + other shared files -----
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [noElectron, { name: 'react', message: 'src/shared never imports React.' }],
          patterns: [noNodeBuiltins],
        },
      ],
    },
  },
  // ----- src/main: no console, no non-literal dynamic import, electron allow-list, agent/llm/exec boundaries -----
  {
    files: ['src/main/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned.',
        },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is banned.' },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is banned.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is banned.' },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned.',
        },
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: 'Dynamic import() in src/main must use a string literal.',
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts'],
    ignores: ELECTRON_ALLOWED,
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron] }] },
  },
  {
    files: ['src/main/agent/**/*.ts', 'src/main/llm/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [noElectron],
          patterns: [
            { regex: String.raw`(^|/)exec(/|$)`, message: 'agent/** and llm/** never import exec/**.' },
            {
              regex: String.raw`(^|/)bridge/sendClient(\.ts)?$`,
              message: 'agent/** and llm/** never import bridge/sendClient.',
            },
            {
              regex: String.raw`(^|/)mcp/writeClient(\.ts)?$`,
              message: 'agent/** and llm/** never import mcp/writeClient.',
            },
            {
              regex: String.raw`(^|/)mcp/adminClient(\.ts)?$`,
              message: 'agent/** and llm/** never import mcp/adminClient.',
            },
            { regex: String.raw`(^|/)mcp/host(\.ts)?$`, message: 'agent/** and llm/** never import mcp/host.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/exec/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [noElectron],
          patterns: [
            { regex: String.raw`(^|/)llm(/|$)`, message: 'exec/** never imports llm/**.' },
            { regex: String.raw`(^|/)agent(/|$)`, message: 'exec/** never imports agent/**.' },
          ],
        },
      ],
    },
  },
  // ----- [V2] rule 13 boundaries (each block is the union for its files; see the note at the top) -----
  {
    files: ['src/main/exec/autoGate.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron], patterns: [...EXEC_V1, ...AUTOGATE_V2] }] },
  },
  {
    files: ['src/main/agent/waTools.ts', 'src/main/agent/handles.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noElectron], patterns: [...AGENT_LLM_V1, ...WA_READ_SURFACE_V2] }],
    },
  },
  {
    files: ['src/main/mcp/toolServer.ts', 'src/main/bridge/waReadClient.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron], patterns: WA_READ_SURFACE_V2 }] },
  },
  {
    files: ['src/main/llm/cli/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron], patterns: [...AGENT_LLM_V1, ...LLM_CLI_V2] }] },
  },
  {
    files: ['src/main/media/**/*.ts'],
    ignores: ['src/main/media/fetch.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron], patterns: MEDIA_V2 }] },
  },
  {
    files: ['src/main/media/fetch.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [noElectron], patterns: MEDIA_V2.slice(1) }] },
  },
  // ----- src/renderer: React hooks, no electron / node, no physical Tailwind classes, no window.api outside api.ts -----
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      'no-restricted-imports': ['error', { paths: [noElectron], patterns: [noNodeBuiltins] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML is banned.',
        },
        { selector: "Property[key.name='dangerouslySetInnerHTML']", message: 'dangerouslySetInnerHTML is banned.' },
        { selector: "MemberExpression[property.name='innerHTML']", message: 'innerHTML is banned.' },
        { selector: "MemberExpression[property.name='outerHTML']", message: 'outerHTML is banned.' },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML is banned.',
        },
        {
          selector: `Literal[value=/${PHYSICAL_CLASS_RE}/]`,
          message:
            'Physical Tailwind classes (ml/mr/pl/pr/left/right/text-left/text-right) are banned; use logical utilities.',
        },
        {
          selector: `TemplateElement[value.raw=/${PHYSICAL_CLASS_RE}/]`,
          message:
            'Physical Tailwind classes (ml/mr/pl/pr/left/right/text-left/text-right) are banned; use logical utilities.',
        },
      ],
    },
  },
  // ----- tests and scripts: relaxed globals -----
  {
    files: ['tests/**/*.{ts,tsx,mjs}', 'scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
);
