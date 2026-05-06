# git-commit-writer

`gcw` is a small interactive CLI that writes Conventional Commit messages from staged Git changes.

It can stage files, build compact Git context, ask a configurable LLM provider for a commit message, and then let you commit, edit, regenerate, refine, or copy the result.

---

## Install

```bash
npm install
npm run build
npm link
```

Set your provider key.

```bash
# Windows PowerShell
$env:OPENAI_API_KEY="your_api_key"

# Windows CMD
setx OPENAI_API_KEY "your_api_key"

# macOS / Linux
export OPENAI_API_KEY="your_api_key"
```

Restart your terminal after using `setx`.

---

## Usage

```bash
gcw
```

`gcw` opens an interactive flow:

```text
? Select files to stage
  ↑/↓ move · Space select · Enter confirm

  ◯ ★ Stage all changes

  src/
  ├─ ◯ ± GitService.ts (+12/-4)
  ├─ ● + ContextBuilder.ts (+80)
  └─ ◯ ? UI.ts (+24)
```

Markers:

```text
◯ not selected
● selected
```

Status icons:

```text
± modified
+ added
- deleted
→ renamed
? untracked
```

If files are already staged, you can select:

```text
◯ ↳ use already staged files
```

---

## After generation

Choose what to do with the generated commit message:

```text
Commit
Edit message manually
Regenerate
Refine with instruction
Copy to clipboard
Cancel
```

Example refine instruction:

```text
Focus on the TypeScript migration
```

---

## Issue references

Pass issue numbers directly:

```bash
gcw 123
gcw 42 99
```

This appends:

```text
refs #123
```

or:

```text
refs #42, #99
```

If no issue is passed, `gcw` can infer one from the branch name:

```text
feature/123-login -> #123
```

---

## Config

Runtime behavior lives in:

```text
src/config/config.ts
```

Change this file to configure:

```text
- LLM provider
- reasoning and generation models
- Git/context limits
- commit-message constraints
- staging prompt behavior
- UI labels
```

Example:

```ts
llm: {
  provider: "openai",
  reasoningModel: "gpt-4o-mini",
  generationModel: "gpt-4o-mini",
}
```

---

## LLM providers

Providers live in:

```text
src/llm/
  LLM.ts
  index.ts
  OpenAIProvider.ts
  OllamaProvider.ts
```

`LLM.ts` defines the small interface used by the app.  
`index.ts` maps provider names to provider classes.

To add a provider:

```text
1. Add ProviderName to LLMProviderName in config.ts
2. Create a provider class implementing LLM
3. Add it to the provider map in src/llm/index.ts
4. Select it in config.ts
```

---

## Context strategy

`gcw` builds context from staged changes.

```text
Level 0: diff only
Level 1: diff with surrounding context
Level 2: full before/after file content
```

Small files get full context. Larger files are reduced automatically.  
Deleted files are represented as deleted without sending the removed content.

---

## Project layout

```text
src/
  index.ts              CLI entrypoint
  core/                 app orchestration
  config/               central typed config
  commit/               prompt and commit-message generation
  context/              staged-change context builder
  git/                  Git wrapper and repo metadata
  llm/                  provider abstraction and implementations
  staging/              file selection and staging UI
  types/                shared types
  ui/                   generic UI helpers
```

---

## Development

```bash
npm install
npm run build
node dist/index.js
```

Clean build output:

```bash
npm run clean
```

Recommended `.gitignore`:

```gitignore
node_modules/
dist/
.DS_Store
```

`dist/` is generated and does not need to be committed.

---

## Notes

- Uses staged Git changes for analysis.
- Can stage selected files before generation.
- Shows changed files as a tree with status icons and diff stats.
- Uses a two-pass generation flow:
  - extract dominant intent
  - write final commit message
- Keeps Git access inside `GitService`.
- Keeps model access behind the `LLM` interface.
- Keeps runtime behavior centralized in `config.ts`.