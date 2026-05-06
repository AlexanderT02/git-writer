# git-commit-writer

`gcw` is a small interactive CLI tool that helps write Conventional Commit messages from staged Git changes.

It can stage files, inspect the staged diff, build compact commit context, generate a commit message through a configurable LLM provider, and then let you commit, edit, regenerate, refine, or copy the result.

---

## Setup

### 1. Set your provider API key

For the default OpenAI provider:

```bash
# Windows PowerShell
$env:OPENAI_API_KEY="your_api_key"

# Windows CMD
setx OPENAI_API_KEY "your_api_key"

# macOS / Linux
export OPENAI_API_KEY="your_api_key"
```

After using `setx` on Windows, restart your terminal.

If you switch to another provider, configure the required credentials for that provider.

---

### 2. Install dependencies

```bash
npm install
```

---

### 3. Build the TypeScript project

```bash
npm run build
```

This creates the compiled CLI in `dist/`.

---

### 4. Link the CLI globally

```bash
npm link
```

---

## Usage

```bash
gcw
```

The tool starts interactively. It shows changed files in a tree view and lets you choose which files to stage before generating a commit message.

---

## File Selection

Use arrow keys and Space to select files, then press Enter to confirm:

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

Git status icons:

```text
± modified
+ added
- deleted
→ renamed
? untracked
```

If files are already staged, the menu also shows:

```text
◯ ↳ use already staged files
```

Select it to skip staging and generate a message from the existing staged changes.

---

## Controls after generation

After the commit message is generated, choose an action from the menu:

```text
Commit
Edit message manually
Regenerate
Refine with instruction
Copy to clipboard
Cancel
```

### Refine example

```text
Focus on the TypeScript migration
```

The tool regenerates the commit message using that instruction.

---

## Issue References

Pass issue numbers directly as arguments:

```bash
gcw 123
gcw 42 99
```

The final commit message will end with:

```text
refs #123
```

or:

```text
refs #42, #99
```

The tool can also infer an issue from the branch name, for example:

```text
feature/123-login
```

becomes:

```text
#123
```

---

## Configuration

Project behavior is centralized in:

```text
src/config/config.ts
```

Use this file to change:

```text
- active LLM provider
- reasoning and generation models
- Git context limits
- commit-message constraints
- staging prompt options
- UI labels and rendering behavior
```

Example:

```ts
llm: {
  provider: "openai",
  reasoningModel: "gpt-4o-mini",
  generationModel: "gpt-4o-mini",
}
```

To switch providers, update the provider in config and ensure the provider exists in `src/llm/`.

---

## LLM Providers

LLM access is isolated behind a small provider interface:

```text
src/llm/
  LLM.ts
  index.ts
  OpenAIProvider.ts
  OllamaProvider.ts
```

The rest of the app does not depend directly on OpenAI or any other provider.

To add a new provider:

```text
1. Create a provider class in src/llm/
2. Implement the LLM interface
3. Register/select it in src/llm/index.ts
4. Set it in src/config/config.ts
```

---

## How context is built

The tool uses staged Git changes as input.

For each staged file, it chooses the richest context that still fits the context budget:

```text
Level 0: diff only
Level 1: diff with surrounding context
Level 2: full before/after file content
```

Small files receive full context. Larger files are reduced automatically.

Deleted files are represented as deleted without sending the full removed content. This keeps prompts focused and avoids wasting context budget.

---

## Architecture

The project is split by responsibility:

```text
src/
  index.ts              CLI entrypoint
  core/                 app orchestration
  config/               central typed configuration
  commit/               prompt building and commit-message generation
  context/              staged-change context building
  git/                  Git command wrapper and repository metadata
  llm/                  provider abstraction and provider implementations
  staging/              file selection and staging UI
  types/                shared TypeScript types
  ui/                   generic interactive UI helpers
```

---

## Project files

```text
package-lock.json
package.json
README.md
tsconfig.json
src/
  index.ts
  core/
    App.ts
  config/
    config.ts
  commit/
    CommitGenerator.ts
  context/
    ContextBuilder.ts
  git/
    GitService.ts
  llm/
    index.ts
    LLM.ts
    OllamaProvider.ts
    OpenAIProvider.ts
  staging/
    StagingService.ts
    treePrompt.ts
  types/
    types.ts
  ui/
    UI.ts
```

---

## Development

Install and build:

```bash
npm install
npm run build
```

Run without linking:

```bash
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
.env
.DS_Store
```

`dist/` is generated by `npm run build` and does not need to be committed.

---

## Notes

- Uses staged Git changes for analysis.
- Can stage selected files before generation.
- Shows changed files as a tree with status icons and diff stats.
- Uses a two-pass generation flow:
  - first pass extracts dominant intent
  - second pass writes the final commit message
- Keeps Git access inside `GitService`.
- Keeps model access behind the `LLM` provider interface.
- Keeps runtime behavior centralized in `config.ts`.