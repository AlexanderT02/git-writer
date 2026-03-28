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

This installs: `chalk` (colors), `ora` (spinner), `inquirer` (interactive prompts).

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

The tool starts interactively, shows all changed files as a checkbox list, and lets you pick what to stage before generating a message.

---

## File Selection

Use arrow keys and space to select files, then press Enter to confirm:

```
? Pick files to stage
❯ ◯ modified   src/index.js
  ◯ new file   src/utils.js
  ◯ untracked  .env.example
```

If files are already staged, you can skip selection by pressing Enter with nothing selected.

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