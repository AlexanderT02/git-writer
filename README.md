# Git Writer

Generate clean commit messages and pull request descriptions from your Git changes using LLMs.

Git Writer helps you turn local diffs into useful text:

- `gw commit` creates a Conventional Commit message from staged changes
- `gw pr` creates a concise Markdown pull request description for the current branch

It supports interactive workflows, local models via Ollama, and OpenAI.

[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional_Commits-1.0.0-FE5196?style=flat-square&logo=conventionalcommits&logoColor=white)](https://conventionalcommits.org)

![Select files to stage](assets/stage-files.svg)

![Generated commit message](assets/generated-commit.svg)

---

## Features

- Generate Conventional Commit messages from staged Git changes
- Generate Markdown PR titles and descriptions from branch diffs
- Compare PR changes against a selected base branch
- Interactive file staging for commits
- Interactive PR preview with copy-to-clipboard support
- Fast commit mode for staging, generating, and committing in one step
- Issue references from CLI arguments or branch names
- Supports OpenAI and Ollama
- Extensible LLM provider interface

---

## Install

```bash
git clone https://github.com/AlexanderT02/git-writer.git
cd git-writer
npm install
npm run build
npm link
```

Verify:

```bash
gw --help
```

If you still expose the old command during migration:

```bash
gcw --help
```

---

## Usage

### Commit message

Generate a commit message from staged changes:

```bash
gw commit
```

Short alias:

```bash
gw c
```

The interactive flow lets you:

| Action | Description |
|---|---|
| Commit | Commit with the generated message |
| Edit | Manually edit the message |
| Regenerate | Generate a new message |
| Refine | Add an instruction and regenerate |
| Copy | Copy the message |
| Cancel | Exit |

### Fast commit mode

Stage all changes, generate a message, and commit immediately:

```bash
gw commit --fast
gw c -f
```

### Issue references

Append issue references:

```bash
gw commit 123
gw c 42 99
```

Example output:

```txt
feat(cli): add staged file selection

refs #123
```

---

## Pull request descriptions

Generate a local PR title and Markdown body:

```bash
gw pr
```

Short alias:

```bash
gw p
```

Use a specific base branch:

```bash
gw pr --base origin/main
gw p -b develop
```

The PR command compares the current branch against the base branch and uses:

- branch name
- issue reference from branch name, if available
- commits ahead of the base branch
- diff stats
- relevant file context

Example output:

```md
# feat(pr): add local PR description generation

## Summary
Adds a local PR generation flow that creates a concise Markdown title and body from branch changes.

## Changes
- Adds PR context generation from branch diffs and commits
- Adds an interactive PR preview flow
- Adds copy-to-clipboard support for generated PR text

## Risks
- Depends on accurate base branch selection
```

---

## CLI

```bash
gw <command> [options]
```

### Commands

| Command | Alias | Description |
|---|---:|---|
| `commit` | `c` | Generate a commit message |
| `pr` | `p` | Generate a PR title and body |

### Options

| Option | Description |
|---|---|
| `-f`, `--fast` | Skip interactive commit prompts |
| `-b`, `--base <branch>` | Base branch for PR comparison |
| `-h`, `--help` | Show help |

---

## Configuration

Edit `src/config/config.ts`.

### OpenAI

```ts
export const config = {
  llm: {
    provider: "openai",
    reasoningModel: "gpt-4o-mini",
    generationModel: "gpt-4o-mini",
  },
};
```

Set your API key:

```bash
export OPENAI_API_KEY="your_api_key"
```

### Ollama

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

Using Ollama keeps generation local.

---

## Project structure

```txt
src/
  index.ts        CLI entrypoint
  core/           App orchestration
  git/            Git commands, diffs, commits, branch data
  staging/        File selection and staging
  context/        Commit and PR context builders
  generation/         Commit and PR text generation
  llm/            LLM providers
  config/         Runtime configuration
  ui/             Terminal UI helpers
```

---

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

Register the provider in:

```txt
src/llm/index.ts
```

Then select it in:

```txt
src/config/config.ts
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run start` | Run `dist/index.js` |
| `npm run lint` | Lint project |
| `npm run lint:fix` | Fix lint issues |
| `npm run check` | Lint and build |
| `npm run clean` | Remove `dist/` |

---

## Privacy

Git Writer sends selected Git context to the configured LLM provider.

Before generating text, review your staged changes:

```bash
git diff --staged
```

For PR generation, review the branch diff:

```bash
git diff <base-branch>..HEAD
```

Do not send secrets, tokens, credentials, private keys, or confidential data to external LLM providers.

Use Ollama if you need local-only generation.