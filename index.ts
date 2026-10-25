// Local/development entrypoint: lets opencode load this repository as a plugin
// directory (for example `"plugins": ["C:/path/to/opencode-github-copilot-auto-model"]`).
// Published installs resolve `dist/index.js` through package.json instead.
export { default } from "./src/index"
