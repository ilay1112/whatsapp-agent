Lint-rule fixtures (W0). Each file MUST trigger the rule named in its header comment; tests/security/import-graph.test.ts runs ESLint
with the root eslint.config.js against this directory (as cwd, so the src/** file patterns apply) and asserts every expected rule id fires.
This directory is ignored by `npm run lint` and by every tsconfig. Files here are deliberately wrong; never copy from them.
