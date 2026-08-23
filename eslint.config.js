import globals from "globals";
import tseslint from "typescript-eslint";

const MATH_RANDOM_MESSAGE =
  "Math.random is banned in this repository, including tests and mocks. " +
  "It is not cryptographically secure. See CLAUDE.md.";

export default [
  {
    // Generated output only. Source directories, including tests, are never ignored.
    ignores: ["dist/", "node_modules/", "android/", "core/pkg/", "core/target/"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: MATH_RANDOM_MESSAGE },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // const { random } = Math
          selector:
            "VariableDeclarator[init.name='Math'] Property[key.name='random']",
          message: MATH_RANDOM_MESSAGE,
        },
        {
          // ({ random } = Math)
          selector:
            "AssignmentExpression[right.name='Math'] Property[key.name='random']",
          message: MATH_RANDOM_MESSAGE,
        },
        {
          // Math["random"], Math[`random`], Math[expr] — no computed access to Math at all
          selector: "MemberExpression[object.name='Math'][computed=true]",
          message:
            "Computed property access on Math is banned: it is an evasion vector for the Math.random ban. Use dot notation.",
        },
      ],
    },
  },
];
