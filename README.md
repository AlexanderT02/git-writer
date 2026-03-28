# ai-commit

Small CLI tool that automatically generates commit messages from staged Git changes — using GPT-4o-mini in Conventional Commits format.

---

## Setup

1. Set your OpenAI API key:

```bash
# Windows
setx OPENAI_API_KEY "your_api_key"

# macOS / Linux
export OPENAI_API_KEY="your_api_key"
```

Restart your terminal afterwards.

---

2. Install dependencies:

```bash
npm install
```

---

3. Link the CLI globally:

```bash
npm link
```

---

## Usage

```bash
aic
```

The tool starts interactively and lists all changed files, letting you choose what to stage before generating a message.

---

## File Selection

```text
Select files:

[1] src/index.js
[2] README.md

[a] all   [p] patch   [c] continue   [q] cancel
```

| Input  | Action |
|--------|--------|
| `1,2`  | Stage specific files by number (comma-separated) |
| `a`    | Stage all files (`git add .`) |
| `p`    | Interactive patch staging (`git add -p`) |
| `c`    | Continue with already staged files |
| `q`    | Cancel |

---

## Controls after generation

```text
[Enter / y]   → commit
[r]           → regenerate
[r:<text>]    → refine (e.g. r:focus on performance)
[n]           → cancel
```

---

## Issue References

Pass issue numbers directly as arguments:

```bash
aic 123
aic #123
aic 42,99
```

The commit message will automatically end with `Refs #123`.

If no argument is given, the tool looks for a number in the current branch name (e.g. `feature/123-login` → `Refs #123`).

---

## Notes

- Uses `git diff --cached` for analysis
- Generates messages in Conventional Commits format
- For large diffs (> 800 lines), automatically falls back to `--stat` summary mode
- Scope and type are inferred from changed files and the diff

---

## Files

```text
index.js
package.json
```