import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { PRContextStateStore } from "../../src/pr/PRContextStateStore.js";

describe("PRContextStateStore", () => {
  let cwd: string;
  let repo: string;

  beforeEach(() => {
    cwd = process.cwd();
    repo = mkdtempSync(join(tmpdir(), "gw-pr-state-"));
    process.chdir(repo);

    git("init");
    git("config", "user.name", "Test User");
    git("config", "user.email", "test@example.com");
    writeFileSync("README.md", "# Test\n");
    git("add", "README.md");
    git("commit", "-m", "chore: init");
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("persists and reads head sha per branch/base key", () => {
    const store = new PRContextStateStore();

    store.setHeadSha(
      "feature/auth",
      "origin/main",
      "abc1234",
      "https://github.com/example/repo/pull/1",
    );

    expect(store.getHeadSha("feature/auth", "origin/main")).toBe("abc1234");
    expect(store.getHeadSha("feature/auth", "main")).toBe("abc1234");
    expect(store.getHeadSha("feature/other", "origin/main")).toBeUndefined();

    const path = join(repo, ".git", "git-writer", "pr-context.json");
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("feature/auth::main");
    expect(raw).toContain("abc1234");
  });
});

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
