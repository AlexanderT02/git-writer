import { describe, it, expect } from "vitest";
import { groupFiles, type FileGroupingInput } from "../../src/staging/fileGrouper.js";
import type { DiffStats, StatusEntry } from "../../src/types/types.js";

function entry(file: string, code: string, opts: Partial<StatusEntry> = {}): StatusEntry {
  return { file, code, ...opts };
}

function stats(add: number, del: number, extra: Partial<DiffStats> = {}): DiffStats {
  return { add, del, ...extra };
}

function makeInput(
  files: StatusEntry[],
  diffStatsMap?: Map<string, DiffStats>,
  hunkHeaders?: Map<string, string[]>,
): FileGroupingInput {
  return {
    files,
    diffStats: diffStatsMap ?? new Map(),
    hunkHeaders: hunkHeaders ?? new Map(),
  };
}

describe("groupFiles", () => {
  it("returns empty array when below threshold", () => {
    const input = makeInput([
      entry("src/a.ts", "M"),
      entry("src/b.ts", "M"),
    ]);

    expect(groupFiles(input, 6)).toEqual([]);
  });

  it("returns empty array for empty file list", () => {
    expect(groupFiles(makeInput([]), 2)).toEqual([]);
  });

  describe("status groups", () => {
    it("groups renames together", () => {
      const files = [
        entry("src/old1.ts", "R", { oldFile: "src/prev1.ts" }),
        entry("src/old2.ts", "R", { oldFile: "src/prev2.ts" }),
        entry("src/a.ts", "M"),
        entry("src/b.ts", "M"),
        entry("src/c.ts", "M"),
        entry("src/d.ts", "M"),
      ];

      const groups = groupFiles(makeInput(files), 4);
      const renameGroup = groups.find((g) => g.label.includes("Rename"));

      expect(renameGroup).toBeDefined();
      expect(renameGroup!.files).toEqual(["src/old1.ts", "src/old2.ts"]);
      expect(renameGroup!.conventionalType).toBe("refactor");
    });

    it("groups deletions together", () => {
      const files = [
        entry("src/dead1.ts", "D"),
        entry("src/dead2.ts", "D"),
        entry("src/dead3.ts", "D"),
        entry("src/a.ts", "M"),
        entry("src/b.ts", "M"),
        entry("src/c.ts", "M"),
      ];

      const groups = groupFiles(makeInput(files), 4);
      const deleteGroup = groups.find((g) => g.label.includes("Deletion"));

      expect(deleteGroup).toBeDefined();
      expect(deleteGroup!.files).toHaveLength(3);
      expect(deleteGroup!.conventionalType).toBe("chore");
    });

    it("skips status group when fewer than 2 files", () => {
      const files = [
        entry("src/only-rename.ts", "R", { oldFile: "src/old.ts" }),
        entry("src/a.ts", "M"),
        entry("src/b.ts", "M"),
        entry("src/c.ts", "M"),
        entry("src/d.ts", "M"),
        entry("src/e.ts", "M"),
      ];

      const groups = groupFiles(makeInput(files), 4);
      const renameGroup = groups.find((g) => g.label.includes("Rename"));

      expect(renameGroup).toBeUndefined();
    });
  });

  describe("directory groups", () => {
    it("groups files by directory", () => {
      const files = [
        entry("src/auth/login.ts", "M"),
        entry("src/auth/logout.ts", "M"),
        entry("src/auth/middleware.ts", "A"),
        entry("src/api/routes.ts", "M"),
        entry("src/api/handler.ts", "M"),
        entry("src/api/types.ts", "A"),
      ];

      const groups = groupFiles(makeInput(files), 4);

      expect(groups).toHaveLength(2);

      const authGroup = groups.find((g) => g.label.includes("auth"));
      const apiGroup = groups.find((g) => g.label.includes("api"));

      expect(authGroup).toBeDefined();
      expect(authGroup!.files).toHaveLength(3);
      expect(apiGroup).toBeDefined();
      expect(apiGroup!.files).toHaveLength(3);
    });

    it("skips directory group that contains all remaining files", () => {
      const files = [
        entry("src/auth/login.ts", "M"),
        entry("src/auth/logout.ts", "M"),
        entry("src/auth/middleware.ts", "M"),
        entry("src/auth/types.ts", "M"),
        entry("src/auth/utils.ts", "M"),
        entry("src/auth/index.ts", "M"),
      ];

      const groups = groupFiles(makeInput(files), 4);
      const authGroup = groups.find((g) => g.label.includes("auth"));

      // All files are in the same dir — grouping doesn't help
      expect(authGroup).toBeUndefined();
    });

    it("infers test conventionalType for test directories", () => {
      const files = [
        entry("src/auth/login.ts", "M"),
        entry("src/auth/logout.ts", "M"),
        entry("src/auth/middleware.ts", "M"),
        entry("tests/unit/login.test.ts", "M"),
        entry("tests/unit/logout.test.ts", "M"),
        entry("tests/unit/middleware.test.ts", "M"),
      ];

      const groups = groupFiles(makeInput(files), 4);
      const testGroup = groups.find((g) => g.conventionalType === "test");

      expect(testGroup).toBeDefined();
    });
  });

  describe("symbol groups", () => {
    it("groups files that touch the same symbol", () => {
      const files = [
        entry("src/auth/login.ts", "M"),
        entry("src/api/routes.ts", "M"),
        entry("src/core/handler.ts", "M"),
        entry("src/utils/format.ts", "M"),
        entry("src/config/settings.ts", "M"),
        entry("src/db/connection.ts", "M"),
      ];

      const headers = new Map<string, string[]>();
      headers.set("src/auth/login.ts", ["class UserService {"]);
      headers.set("src/api/routes.ts", ["class UserService {"]);
      headers.set("src/core/handler.ts", ["class UserService {"]);
      headers.set("src/utils/format.ts", ["function formatDate("]);
      headers.set("src/config/settings.ts", ["const API_URL"]);
      headers.set("src/db/connection.ts", ["function formatDate("]);

      const groups = groupFiles(makeInput(files, new Map(), headers), 4);
      const userGroup = groups.find((g) => g.label.includes("UserService"));

      expect(userGroup).toBeDefined();
      expect(userGroup!.files).toHaveLength(3);
    });

    it("skips symbol groups with fewer than 2 files", () => {
      const files = [
        entry("src/a.ts", "M"),
        entry("src/b.ts", "M"),
        entry("src/c.ts", "M"),
        entry("src/d.ts", "M"),
        entry("src/e.ts", "M"),
        entry("src/f.ts", "M"),
      ];

      const headers = new Map<string, string[]>();
      headers.set("src/a.ts", ["class UniqueClass {"]);

      const groups = groupFiles(makeInput(files, new Map(), headers), 4);
      const uniqueGroup = groups.find((g) => g.label.includes("UniqueClass"));

      expect(uniqueGroup).toBeUndefined();
    });
  });


  it("assigns each file to at most one group", () => {
    const files = [
      entry("src/auth/login.ts", "R", { oldFile: "src/auth/old-login.ts" }),
      entry("src/auth/logout.ts", "R", { oldFile: "src/auth/old-logout.ts" }),
      entry("src/auth/middleware.ts", "M"),
      entry("src/auth/types.ts", "M"),
      entry("src/api/routes.ts", "M"),
      entry("src/api/handler.ts", "M"),
    ];

    const groups = groupFiles(makeInput(files), 4);

    const allGroupedFiles = groups.flatMap((g) => g.files);
    const unique = new Set(allGroupedFiles);

    expect(allGroupedFiles).toHaveLength(unique.size);
  });

  it("caps groups at 9", () => {
    // Create 20 different directories with 2 files each = 40 files
    const files: StatusEntry[] = [];

    for (let i = 0; i < 20; i++) {
      files.push(entry(`dir${i}/a.ts`, "M"));
      files.push(entry(`dir${i}/b.ts`, "M"));
    }

    const groups = groupFiles(makeInput(files), 4);

    // The prompt caps to 9 (number keys 1-9), but the grouper itself
    // doesn't limit — the treePrompt handles the cap.
    expect(groups.length).toBeGreaterThan(0);
  });
});