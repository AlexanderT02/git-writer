import { execSync, spawnSync } from "child_process";
import chalk from "chalk";

export class GitService {
  getBranch() {
    return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
  }

  getStatus() {
    return execSync("git status --porcelain").toString().trim();
  }

  getLastCommitSummary() {
    try {
      const output = execSync("git show --shortstat -1").toString().trim();
      const match = output.match(
        /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
      );
      if (!match) return null;

      return {
        files: match[1],
        insertions: match[2] || 0,
        deletions: match[3] || 0,
      };
    } catch {
      return null;
    }
  }

  getStagedFiles() {
    return execSync("git diff --cached --name-only").toString().trim();
  }

  getStagedFileSummaries() {
    try {
      const status = execSync("git diff --cached --name-status")
        .toString()
        .trim();
      if (!status) return "";

      return status
        .split("\n")
        .map((line) => {
          const [status, ...rest] = line.trim().split(/\s+/);
          return `${status}: ${rest.join(" ")}`;
        })
        .join("\n");
    } catch {
      return "";
    }
  }

  getStagedStats() {
    try {
      return execSync("git diff --cached --shortstat").toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommits(n = 8) {
    try {
      return execSync(`git log --oneline -${n} --no-merges`).toString().trim();
    } catch {
      return "";
    }
  }

  getRecentCommitStyleHints(n = 12) {
    try {
      const commits = execSync(`git log --format=%s -${n} --no-merges`)
        .toString()
        .trim();
      if (!commits) return "";

      const scopes = new Set();
      const types = new Set();

      for (const line of commits.split("\n")) {
        const match = line.match(/^(\w+)(?:\(([^)]+)\))?:/);
        if (match) {
          types.add(match[1]);
          if (match[2]) scopes.add(match[2]);
        }
      }

      return [
        types.size ? `Recent commit types: ${[...types].join(", ")}` : "",
        scopes.size
          ? `Recent scopes: ${[...scopes].slice(0, 10).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch {
      return "";
    }
  }

  getBranchContext() {
    const branch = this.getBranch();
    const issueMatch = branch.match(/[/#-](\d{2,})/);

    return {
      branch,
      issue: issueMatch ? `#${issueMatch[1]}` : null,
    };
  }

  getFileTypeHints(stagedFiles) {
    const files = stagedFiles
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const hints = new Set();

    const extMap = {
      ".java": "Java",
      ".kt": "Kotlin",
      ".scala": "Scala",
      ".ts": "TypeScript",
      ".tsx": "TypeScript/React",
      ".js": "JavaScript",
      ".jsx": "JavaScript/React",
      ".py": "Python",
      ".go": "Go",
      ".rs": "Rust",
      ".rb": "Ruby",
      ".php": "PHP",
      ".cs": "C#",
      ".cpp": "C++",
      ".c": "C",
      ".swift": "Swift",
    };

    for (const file of files) {
      for (const [ext, lang] of Object.entries(extMap)) {
        if (file.endsWith(ext)) hints.add(lang);
      }

      if (/[Tt]est|[Ss]pec/.test(file)) hints.add("includes tests");
      if (/migration/i.test(file)) hints.add("includes DB migration");
      if (file.endsWith(".md") || file.endsWith(".mdx"))
        hints.add("includes docs");
      if (/Dockerfile|docker-compose/i.test(file)) hints.add("Docker config");
      if (/\.ya?ml$/i.test(file) && /ci|github|gitlab|pipeline/i.test(file))
        hints.add("CI config");
      if (
        /pom\.xml|build\.gradle|package\.json|Cargo\.toml|go\.mod/i.test(file)
      )
        hints.add("build/dep file");
    }

    return [...hints].join(", ");
  }

  getChangedSymbols() {
    try {
      const raw = execSync("git diff --cached --unified=0").toString();
      const symbols = new Set();

      const hunkHeader = /^@@[^@]+@@\s*(.+)$/gm;
      let match;

      while ((match = hunkHeader.exec(raw)) !== null) {
        const ctx = match[1].trim();
        if (ctx && ctx.length < 120) symbols.add(ctx);
      }

      return [...symbols].slice(0, 30).join("\n");
    } catch {
      return "";
    }
  }

  getDiff() {
    const raw = execSync("git diff --cached").toString();
    const lines = raw.split("\n");

    if (lines.length <= 800) {
      return raw;
    }

    console.log(chalk.yellow("⚠ Large diff — semantic summary mode\n"));

    try {
      const stat = execSync("git diff --cached --stat").toString().trim();
      const headers = execSync("git diff --cached --unified=0")
        .toString()
        .split("\n")
        .filter((line) => line.startsWith("+++") || line.startsWith("@@"))
        .slice(0, 150)
        .join("\n");

      return `[CHANGED FILES]\n${stat}\n\n[CHANGED SYMBOLS & HUNKS]\n${headers}`;
    } catch {
      return execSync("git diff --cached --stat").toString();
    }
  }

  /**
   * Get full file content before and after for each staged file.
   * Budget scales per-file based on total file count.
   */
  getFullFileContext(maxCharsPerFile = 6000, maxTotalChars = 50000) {
    const stagedStatus = execSync("git diff --cached --name-status")
      .toString()
      .trim();

    if (!stagedStatus) return "";

    const entries = stagedStatus.split("\n").map((line) => {
      const parts = line.trim().split(/\s+/);
      const status = parts[0][0]; // normalise R100 → R
      const file = parts[parts.length - 1];
      return { status, file };
    });

    const blocks = [];
    let totalChars = 0;

    for (const { status, file } of entries) {
      if (totalChars >= maxTotalChars) {
        blocks.push(`[remaining files omitted — budget exhausted]`);
        break;
      }

      // skip binary files
      const isBinary = (() => {
        try {
          const out = execSync(
            `git diff --cached --numstat -- "${file}"`,
          ).toString();
          return out.startsWith("-\t-\t");
        } catch {
          return false;
        }
      })();

      if (isBinary) {
        blocks.push(`=== ${file} ===\n[binary — skipped]`);
        continue;
      }

      // content BEFORE (HEAD) — empty for new files
      let before = "";
      if (status !== "A") {
        try {
          before = execSync(`git show HEAD:"${file}"`, {
            maxBuffer: 10 * 1024 * 1024,
          }).toString();
        } catch {
          before = "";
        }
      }

      // content AFTER (index) — empty for deleted files
      let after = "";
      if (status !== "D") {
        try {
          after = execSync(`git show :"${file}"`, {
            maxBuffer: 10 * 1024 * 1024,
          }).toString();
        } catch {
          after = "";
        }
      }

      // truncate from the middle so imports/exports stay visible
      const truncate = (text, limit) => {
        if (text.length <= limit) return text;
        const half = Math.floor(limit / 2);
        return (
          text.slice(0, half) +
          `\n\n... [${text.length - limit} chars omitted] ...\n\n` +
          text.slice(text.length - half)
        );
      };

      const beforeTrunc = truncate(before, maxCharsPerFile);
      const afterTrunc = truncate(after, maxCharsPerFile);

      const block = [
        `=== ${file} (${status}) ===`,
        `--- BEFORE ---`,
        beforeTrunc || "(new file)",
        `--- AFTER ---`,
        afterTrunc || "(deleted)",
      ].join("\n");

      totalChars += block.length;
      blocks.push(block);
    }

    return blocks.join("\n\n");
  }

  add(files) {
    spawnSync("git", ["add", "--", ...files], { stdio: "inherit" });
  }

  commit(message) {
    execSync("git commit -F -", {
      input: message,
      stdio: ["pipe", "ignore", "ignore"],
    });
  }
}