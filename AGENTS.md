# Repository Guidelines

## Project Structure & Module Organization

AWS Field is a Node.js 22+ web app. The HTTP server is `server.mjs`; browser code and static assets live in `public/`. Automated tests are in `test/` and use Node's built-in test runner. `data/workspace.json` contains the local editable diagram and is excluded from Git; keep user workspace data out of commits. `README.md` documents setup, usage, and the app's modeling limits.

## Build, Test, and Development Commands

- `npm install --no-audit --no-fund` installs the pinned Three.js dependency.
- `npm start` runs the server at the configured port (default 4187); `./start.sh` also checks for Node.js 22 or newer.
- `npm test` runs all tests with `node --test`.
- Set `PORT` to change the listener and `AWS_FIELD_DATA` to store workspace data in another directory.

There is no separate build or lint step.

## Coding Style & Naming Conventions

Use ECMAScript modules (`.mjs`) and the existing four-space indentation in JavaScript. Keep browser modules in `public/` and name tests `*.test.mjs`. Follow nearby patterns, use descriptive lower camel case for variables and functions, and avoid adding dependencies unless the feature needs them.

## Testing Guidelines

Add or update tests in the relevant file under `test/`; use Node's `node:test` and `node:assert/strict` APIs. Cover model validation, simulation, learning behavior, and persistence changes as applicable. Run `npm test` before submitting changes.

## Commits & Pull Requests

This checkout has no Git history yet, so no existing commit convention is established. Use short imperative commit subjects (for example, `Add route validation tests`). PRs should explain the user-visible change, list verification performed, link related issues when available, and include screenshots for UI changes.

## Security & Configuration

The app edits local diagram data and does not connect to or deploy AWS services. Keep credentials, machine-specific configuration, `node_modules/`, and local `data/` files out of commits.
