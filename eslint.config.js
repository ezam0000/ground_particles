import globals from "globals";

export default [
    {
        ignores: ["node_modules/**", "dist/**"],
    },
    {
        files: ["src/**/*.js", "scripts/**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "no-constant-condition": "error",
            "no-dupe-keys": "error",
            "no-duplicate-case": "error",
            "no-unreachable": "error",
            "no-redeclare": "error",
            "no-fallthrough": "error",
            "no-useless-assignment": "error",
            eqeqeq: ["error", "always", { null: "ignore" }],
            "no-var": "error",
            "prefer-const": "error",
        },
    },
];
