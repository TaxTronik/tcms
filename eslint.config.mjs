// =============================================================================
// ESLint nur für Regeln, die der Typecheck nicht abdeckt: unbehandelte und
// falsch verwendete Promises. Eine nicht abgewartete Abfrage innerhalb einer
// interaktiven Prisma-Transaktion läuft nach dem Commit weiter oder geht
// verloren; ein nicht abgewartetes `expect(...).rejects` prüft nichts.
// Keine Stilregeln – Format macht Prettier.
// =============================================================================
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts'],
  },
  {
    files: ['packages/*/src/**/*.ts', 'packages/db/seeds/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
);
