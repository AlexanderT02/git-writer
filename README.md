# ai-commit

Small CLI to generate git commit messages from staged changes.

---

## Setup

1. Set your OpenAI API key:

```bash id="3nkn9s"
setx OPENAI_API_KEY "your_api_key"
```

Restart your terminal afterwards.

---

2. Install dependencies:

```bash id="h6r3q7"
npm install
```

---

3. Link the CLI (so you can use it globally):

```bash id="c0u5l1"
npm link
```

---

## Usage

Stage your changes:

```bash id="o8xy1v"
git add .
```

Run:

```bash id="6n8r0s"
ai-commit
```

---

## Controls

```text id="q3b8fw"
Enter / y  → commit
r          → regenerate
r:<text>   → refine output
n          → cancel
```

---

## Notes

* Uses `git diff --cached`
* Generates a conventional commit message
* Adds `Refs #<number>` if branch contains a number
* Large diffs may be slower

---

## Files

```text id="7r8w0d"
index.js
package.json
```
