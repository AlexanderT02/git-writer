import { describe, it, expect, vi } from "vitest";
import { createTestConfig } from "./helpers.js";

describe("createLLM factory", () => {
  it("throws when default provider has no model config", async () => {
    // Dynamic import to avoid top-level side effects
    const { createLLMProvider: createLLM } = await import("../../src/llm/Factory.js");

    const config = createTestConfig();

    (config.llm as any).defaultProvider = "nonexistent";

    expect(() => createLLM(config)).toThrow(
      "Missing config for LLM provider: nonexistent",
    );
  });

  it("throws when provider override has no model config", async () => {
    const { createLLMProvider: createLLM } = await import("../../src/llm/Factory.js");

    const config = createTestConfig();

    expect(() => createLLM(config, "nonexistent" as any)).toThrow(
      "Missing config for LLM provider: nonexistent",
    );
  });

  it("throws when provider has config but no implementation", async () => {
    const { createLLMProvider: createLLM } = await import("../../src/llm/Factory.js");

    const config = createTestConfig();

    (config.llm as any).defaultProvider = "fake";
    (config.llm.providers as any).fake = {
      reasoningModel: "fake-reasoning",
      generationModel: "fake-generation",
    };

    expect(() => createLLM(config)).toThrow(
      "Unsupported LLM provider: fake",
    );
  });
});

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { spawnSync } from "child_process";
const mockedSpawnSync = vi.mocked(spawnSync);

import { GitHubCLIService } from "../../src/git/GitHubCliService.js";
import { GitService } from "../../src/git/GitService.js";

function createGHService() {
  const config = createTestConfig();
  const git = new GitService(config);
  return new GitHubCLIService(git);
}

describe("GitHubCLIService", () => {

  describe("normalizeBaseBranch", () => {
    it("strips origin/ prefix", () => {
      const svc = createGHService();
      expect(svc.normalizeBaseBranch("origin/main")).toBe("main");
      expect(svc.normalizeBaseBranch("origin/develop")).toBe("develop");
    });

    it("leaves non-origin branches unchanged", () => {
      const svc = createGHService();
      expect(svc.normalizeBaseBranch("main")).toBe("main");
      expect(svc.normalizeBaseBranch("upstream/main")).toBe("upstream/main");
    });
  });

  describe("isGitHubCliInstalled", () => {
    it("returns true when gh --version succeeds", () => {
      mockedSpawnSync.mockReturnValue({ status: 0, stdout: "gh version 2.40", stderr: "" } as any);
      const svc = createGHService();
      expect(svc.isGitHubCliInstalled()).toBe(true);
    });

    it("returns false when gh is not found", () => {
      mockedSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "not found" } as any);
      const svc = createGHService();
      expect(svc.isGitHubCliInstalled()).toBe(false);
    });
  });

  describe("isGitHubCliAuthenticated", () => {
    it("returns true when gh auth status succeeds", () => {
      mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);
      const svc = createGHService();
      expect(svc.isGitHubCliAuthenticated()).toBe(true);
    });

    it("returns false when not authenticated", () => {
      mockedSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "not logged in" } as any);
      const svc = createGHService();
      expect(svc.isGitHubCliAuthenticated()).toBe(false);
    });
  });

  describe("getReadinessError", () => {
    it("returns gh_missing when CLI not installed", () => {
      mockedSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "" } as any);
      const svc = createGHService();
      const error = svc.getReadinessError();
      expect(error?.status).toBe("gh_missing");
    });

    it("returns gh_unauthenticated when not logged in", () => {
      let callCount = 0;
      mockedSpawnSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { status: 0, stdout: "gh version", stderr: "" } as any;
        return { status: 1, stdout: "", stderr: "not authenticated" } as any;
      });
      const svc = createGHService();
      const error = svc.getReadinessError();
      expect(error?.status).toBe("gh_unauthenticated");
    });

    it("returns null when everything is ready", () => {
      mockedSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);
      const svc = createGHService();
      expect(svc.getReadinessError()).toBeNull();
    });
  });

  describe("currentBranchIsPushed", () => {
    it("returns true when branch is up to date", () => {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        stdout: "## main...origin/main\n",
        stderr: "",
      } as any);
      const svc = createGHService();
      expect(svc.currentBranchIsPushed()).toBe(true);
    });

    it("returns false when branch is ahead", () => {
      mockedSpawnSync.mockReturnValue({
        status: 0,
        stdout: "## feature...origin/feature [ahead 3]\n",
        stderr: "",
      } as any);
      const svc = createGHService();
      expect(svc.currentBranchIsPushed()).toBe(false);
    });
  });

  describe("createPullRequestFromCurrentBranch", () => {
    it("returns created status with URL on success", () => {
      // Mock all preflight checks as passing, then PR creation succeeding
      let callCount = 0;
      mockedSpawnSync.mockImplementation((_cmd, args: any) => {
        callCount++;
        // gh --version
        if (args?.[0] === "--version") return { status: 0, stdout: "v2", stderr: "" } as any;
        // gh auth status
        if (args?.[0] === "auth") return { status: 0, stdout: "", stderr: "" } as any;
        // git rev-parse upstream check
        if (args?.includes("@{u}")) return { status: 0, stdout: "", stderr: "" } as any;
        // git status --porcelain (pushed check)
        if (args?.includes("--porcelain=v1")) return { status: 0, stdout: "## main...origin/main\n", stderr: "" } as any;
        // gh pr view (no existing PR)
        if (args?.includes("view")) return { status: 1, stdout: "", stderr: "no PR" } as any;
        // gh pr create
        if (args?.includes("create")) return { status: 0, stdout: "https://github.com/user/repo/pull/1", stderr: "" } as any;
        return { status: 0, stdout: "", stderr: "" } as any;
      });

      const svc = createGHService();
      const result = svc.createPullRequestFromCurrentBranch("origin/main", "Title", "Body");
      expect(result.status).toBe("created");
      if (result.status === "created") {
        expect(result.url).toContain("github.com");
      }
    });
  });
});

describe("Error classes", () => {
  it("GracefulExit has correct defaults", async () => {
    const { GracefulExit } = await import("../../src/errors.js");
    const err = new GracefulExit();
    expect(err.code).toBe(0);
    expect(err.name).toBe("GracefulExit");
  });

  it("GracefulExit accepts custom code", async () => {
    const { GracefulExit } = await import("../../src/errors.js");
    const err = new GracefulExit(1, "custom");
    expect(err.code).toBe(1);
    expect(err.message).toBe("custom");
  });

  it("UserCancelledError extends GracefulExit with code 0", async () => {
    const { UserCancelledError, GracefulExit } = await import("../../src/errors.js");
    const err = new UserCancelledError();
    expect(err).toBeInstanceOf(GracefulExit);
    expect(err.code).toBe(0);
    expect(err.name).toBe("UserCancelledError");
  });
});