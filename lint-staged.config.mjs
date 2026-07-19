// Pre-commit checks (run by .husky/pre-commit via lint-staged).
//
// - Formatting runs on the staged files themselves and rewrites them in place;
//   lint-staged re-stages the results.
// - Linting is type-aware (oxlint --type-check needs the whole tsconfig
//   program — pkg/web even type-checks pkg/api internals), so it can't run on
//   an isolated subset. The `() =>` form ignores the staged file list and runs
//   the same project-wide check as `bun lint` whenever any JS/TS file is
//   staged.
export default {
  "*.{ts,tsx,js,jsx,mjs,cjs,json}": "oxfmt --write",
  "*.{ts,tsx,js,jsx,mjs,cjs}": () => "oxlint --type-aware --type-check",
};
