# Git Writer

Git Writer is a small CLI that turns local Git changes into useful text.

It can generate:

- [Conventional Commit](https://www.conventionalcommits.org/) messages from staged or selected files
- Pull request titles and Markdown descriptions from branch diffs
- GitHub pull requests when the GitHub CLI is installed and authenticated
- Local usage statistics for generated output

Git Writer uses OpenAI by default, but the LLM provider is configurable. You can switch to Ollama or add another provider.

Use `gw --help` for the full command reference.

[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional_Commits-1.0.0-FE5196?style=flat-square&logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)

![Select files to stage](assets/stage-files.svg)

![Generated commit message](assets/generated-commit.svg)

---

## Requirements

- Node.js `>= 22`
- Git
- OpenAI API key, Ollama, or another configured LLM provider
- GitHub CLI for creating pull requests from `gw pr`

---

## Install

```bash
git clone https://github.com/AlexanderT02/git-writer.git
cd git-writer
npm install
npm run build
npm link
```

Set your OpenAI API key if you use the default provider:

```bash
export OPENAI_API_KEY="your_api_key"
```

PowerShell:

```powershell
$env:OPENAI_API_KEY="your_api_key"
```

CMD:

```cmd
setx OPENAI_API_KEY "your_api_key"
```

Restart your terminal after using `setx`.

Verify the CLI:

```bash
gw --help
```

---

## Commit workflow

`gw commit` starts the interactive commit flow. The short alias is `gw c`.

It lets you select files, stages them, analyzes the staged diff, and generates a Conventional Commit message.

```bash
gw commit
gw c
```

You can then commit, edit, regenerate, refine, copy, or cancel the generated message.

Issue references can be passed directly:

```bash
gw commit 123
gw c 42 99
```

Git Writer can also infer issue references from branch names such as `feature/123-login` or `fix/456-auth-error`.

### Fast commit mode

Fast mode skips all interaction and generates the commit message directly.

```bash
gw commit --fast
gw c -f
```

---

## Pull request workflow

`gw pr` starts the pull request flow. The short alias is `gw p`.

It compares the current branch against a base branch and generates a PR title plus Markdown body.

```bash
gw pr
gw p
```

By default, Git Writer compares against `origin/main`.

Use another base branch:

```bash
gw pr --base origin/main
gw p -b develop
```

The PR text is based on the current branch, issue reference, commits ahead of the base branch, diff stats, changed files, and relevant file context.

If the GitHub CLI is installed and authenticated, Git Writer can also create the pull request for you.

---

## How it works

Git Writer builds a compact Git context, then uses two LLM steps.

First, it analyzes the change:

- intent
- key changes
- risks
- likely change type

Then it generates the final output:

- a Conventional Commit message for `gw commit`
- a Markdown PR title and body for `gw pr`

Context size is adjusted automatically. Small files can include full before/after content. Larger files use focused diff context. Very large files use minimal context to stay within the token budget.

---

## LLM providers

Git Writer supports multiple LLM providers through the provider layer in `src/llm/provider`.

The available providers and models are configured in:

```txt
src/config/config.ts
```

Example:

```ts
export const config = {
  llm: {
    defaultProvider: "openai",
    providers: {
      openai: {
        reasoningModel: "gpt-4o-mini",
        generationModel: "gpt-4o-mini",
      },
      ollama: {
        reasoningModel: "llama3.1",
        generationModel: "llama3.1",
      },
      gemini: {
        reasoningModel: "gemini-2.5-flash",
        generationModel: "gemini-2.5-flash-lite",
      },
    },
  },
};
```

Check the active provider:

```bash
gw provider get
```

Change the active provider:

```bash
gw provider set openai
gw provider set ollama
gw provider set gemini
```

The selected provider is stored in:

```txt
~/.git-writer/config.json
```

This overrides the source default from `config.llm.defaultProvider`. The model names still come from `src/config/config.ts`.

---

## Development

```bash
npm install
npm run build
npm run test
```

Useful scripts:

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run test` | Run tests |
| `npm run lint` | Lint the project |
| `npm run check` | Run lint and build |
| `npm run clean` | Remove `dist/` |

---

## Privacy

Git Writer sends selected Git context to the configured LLM provider.

Before using external providers, review what you are about to send:

```bash
git diff --staged
git diff <base-branch>...HEAD
```

Do not send secrets, credentials, private keys, tokens, or confidential data to external LLM providers.

Use Ollama or another local provider for local-only generation.
