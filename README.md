# Git Writer

Git Writer is a small CLI that turns your Git changes into useful text.

It can generate:

- [Conventional Commit](https://www.conventionalcommits.org/) messages from staged changes
- Pull request titles and Markdown descriptions from branch diffs

Use it when you want a clean commit message, a quick PR draft, or a local AI-assisted Git workflow without leaving your terminal.

[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional_Commits-1.0.0-FE5196?style=flat-square&logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)

![Select files to stage](assets/stage-files.svg)

![Generated commit message](assets/generated-commit.svg)

---
# Git Writer

Git Writer is a small CLI that turns your Git changes into useful text.

It can generate:

- [Conventional Commit](https://www.conventionalcommits.org/) messages from staged changes
- Pull request titles and Markdown descriptions from branch diffs

Use it when you want a clean commit message, a quick PR draft, or a local AI-assisted Git workflow without leaving your terminal.

[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional_Commits-1.0.0-FE5196?style=flat-square&logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)

![Select files to stage](assets/stage-files.svg)

![Generated commit message](assets/generated-commit.svg)

---

## Quick start

Git Writer uses **OpenAI by default**.

You need:

- Node.js `>= 22`
- an OpenAI API key
- a Git repository

Install and link the CLI:

```bash
git clone https://github.com/AlexanderT02/git-commit-writer.git
cd git-commit-writer
npm install
npm run build
npm link
```

Set your OpenAI API key:

```bash
export OPENAI_API_KEY="your_api_key"
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="your_api_key"
```

Windows CMD:

```cmd
setx OPENAI_API_KEY "your_api_key"
```

Restart your terminal after using `setx`.

Verify the CLI:

```bash
gw --help
```

Generate a commit message:

```bash
gw commit
```

Generate a pull request draft:

```bash
gw pr
```

---

## Using Ollama instead of OpenAI

If you want local generation, switch the provider to `ollama` in:

```txt
src/config/config.ts
```

Example:

```ts
export const config = {
  llm: {
    provider: "ollama",
    reasoningModel: "llama3.1",
    generationModel: "llama3.1",
  },
};
```

Start Ollama:

```bash
ollama serve
```

With Ollama, generation stays local and no OpenAI API key is required.

---

## What it does

Git Writer reads your Git changes, builds a compact context, sends it to a configured LLM provider, and gives you text you can actually use.

### Commit workflow

```bash
gw commit
```

or shorter:

```bash
gw c
```

The commit workflow can:

- show changed files in an interactive tree
- stage selected files
- generate a [Conventional Commit](https://www.conventionalcommits.org/) message
- let you edit, regenerate, refine, copy, or commit the message

### Pull request workflow

```bash
gw pr
```

or shorter:

```bash
gw p
```

The PR workflow compares your current branch against a base branch and creates a local PR draft with:

- a short PR title
- a Markdown body
- summary of changes
- relevant risks or breaking changes

Use a specific base branch:

```bash
gw pr --base origin/main
gw p -b develop
```

---

## Features

- Generate [Conventional Commit](https://www.conventionalcommits.org/) messages from staged Git changes
- Generate local pull request titles and Markdown descriptions
- Select files interactively before generating a commit message
- Compare PR changes against a selected base branch
- Show branch diff stats for PR generation
- Copy generated commit messages or PR drafts to the clipboard
- Fast commit mode for one-command staging, generation, and commit
- Issue references from CLI arguments or branch names
- Supports [OpenAI](https://openai.com/) and [Ollama](https://ollama.com/)
- Extensible provider interface for adding other LLMs

---

## Install

```bash
git clone https://github.com/AlexanderT02/git-commit-writer.git
cd git-commit-writer
npm install
npm run build
npm link
```

Verify the CLI:

```bash
gw --help
```

---

## Usage

```bash
gw <command> [options]
```

### Commands

| Command | Alias | Description |
|---|---:|---|
| `commit` | `c` | Generate a commit message |
| `pr` | `p` | Generate a pull request title and body |

### Options

| Option | Description |
|---|---|
| `-f`, `--fast` | Run commit generation in fast mode |
| `-b`, `--base <branch>` | Base branch for PR comparison |
| `-h`, `--help` | Show help |

---

## Commit messages

Generate a commit message from staged or selected files:

```bash
gw commit
```

The interactive menu lets you choose what to do with the generated message:

| Action | What it does |
|---|---|
| Commit | Create the Git commit |
| Edit | Manually edit the message |
| Regenerate | Generate a new message |
| Refine | Add an instruction and regenerate |
| Copy | Copy the message |
| Cancel | Exit without committing |

Example output:

```txt
feat(cli): add staged file selection

- add interactive file selection before commit generation
- include diff stats in the staging tree
- keep already staged files available as an option
```

### Fast mode

Stage all changes, generate a message, and commit immediately:

```bash
gw commit --fast
gw c -f
```

### Issue references

Pass issue numbers directly:

```bash
gw commit 123
gw c 42 99
```

This appends:

```txt
refs #123
```

or:

```txt
refs #42, #99
```

Git Writer can also infer issue references from branch names like:

```txt
feature/123-login
fix/456-auth-error
```

---

## Pull request drafts

Generate a local PR draft:

```bash
gw pr
```

Use a specific base branch:

```bash
gw pr --base origin/main
gw p -b develop
```

The PR workflow uses:

- current branch name
- issue reference from the branch name, if available
- commits ahead of the base branch
- branch diff stats
- changed files and relevant file context

Example output:

```md
# Add PR generation and rebrand to Git Writer

## Summary

This update expands the CLI from commit-message generation into a broader Git text-generation tool.

## Changes

- Adds a `pr` command for generating pull request titles and descriptions
- Compares the current branch against a selected base branch
- Updates CLI naming, help output, and documentation for Git Writer

## Risks

- Existing scripts using the old `gcw` command may need to be updated
```

---

## Configuration

Configuration lives in:

```txt
src/config/config.ts
```

Git Writer uses **OpenAI by default**. Set your API key before running the CLI:

```bash
export OPENAI_API_KEY="your_api_key"
```

Windows PowerShell:

```powershell
$env:OPENAI_API_KEY="your_api_key"
```

Windows CMD:

```cmd
setx OPENAI_API_KEY "your_api_key"
```

Restart your terminal after using `setx`.

To use local generation instead, switch the provider to `ollama`:

```ts
export const config = {
  llm: {
    provider: "ollama",
    reasoningModel: "llama3.1",
    generationModel: "llama3.1",
  },
};
```

Then start Ollama:

```bash
ollama serve
```

You can also adjust models, Git diff limits, context budget, commit rules, staging behavior, and UI labels in `src/config/config.ts`.

---

## Project structure

```txt
src/
  index.ts        CLI entrypoint
  core/           App orchestration
  config/         Runtime configuration
  context/        Commit and PR context builders
  generation/     Commit and PR text generation
  git/            Git commands, diffs, commits, and branch data
  llm/            LLM provider interface and implementations
  staging/        File selection and staging UI
  types/          Shared TypeScript types
  ui/             Terminal UI helpers
```

---

## How it works

Git Writer first builds a compact Git context, then uses two LLM passes to generate the final text.

### 1. Context building

The context builder decides how much detail to include for each file.

For commits, it uses staged changes:

- branch name and optional issue reference
- staged files, diff stats, and recent commit style
- changed symbols when useful
- file context based on size and token budget

File context has three detail levels:

| Level | Used when | Included context |
|---:|---|---|
| `2` | File is small enough | Full before/after content |
| `1` | File is larger | Diff with surrounding context |
| `0` | File is too large | Minimal diff only |

Deleted and binary files are handled separately. If the context budget is exhausted, files are skipped instead of overloading the prompt.

For PRs, Git Writer compares the current branch against a base branch and includes:

- commits ahead of the base branch
- branch diff and stats
- relevant file context
- branch and issue metadata

### 2. Reasoning pass

The first LLM call analyzes the context and extracts the intent, key changes, risks, and likely change type.

### 3. Message pass

The second LLM call turns that analysis into the final output:

- a [Conventional Commit](https://www.conventionalcommits.org/) message for `gw commit`
- a Markdown PR title and body for `gw pr`

This keeps the model focused: first understand the change, then write the result.

## Adding an LLM provider

Implement the `LLM` interface:

```ts
export interface LLM {
  complete(prompt: string): Promise<string>;

  stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<string>;
}
```

Then:

1. Add the provider implementation in `src/llm/`
2. Register it in `src/llm/index.ts`
3. Select it in `src/config/config.ts`

---

## Development

```bash
npm install
npm run build
node dist/index.js
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run `dist/index.js` |
| `npm run lint` | Lint the project |
| `npm run lint:fix` | Fix lint issues |
| `npm run check` | Run lint and build |
| `npm run clean` | Remove `dist/` |

---

## Privacy

Git Writer sends selected Git context to the configured LLM provider.

Before generating a commit message, review staged changes:

```bash
git diff --staged
```

Before generating a PR draft, review the branch diff:

```bash
git diff <base-branch>..HEAD
```

Do not send secrets, tokens, credentials, private keys, or confidential data to external LLM providers.

Use Ollama if you need local-only generation.

---

## License

[MIT](LICENSE)