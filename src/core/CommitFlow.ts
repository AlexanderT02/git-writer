import clipboard from "clipboardy";

import { config } from "../config/config.js";
import type { CommitGenerator } from "../generation/CommitGenerator.js";
import type { CommitContextBuilder } from "../context/CommitContextBuilder.js";
import type { GitService } from "../git/GitService.js";
import type { StagingService } from "../staging/StagingService.js";
import { UI } from "../ui/UI.js";
import { GracefulExit, UserCancelledError } from "../errors.js";
import type { UsageTracker } from "../stats/UsageTracker.js";
import type { GenerationUsage, UsageEntryBuilder } from "./App.js";

export class CommitFlow {
  constructor(
    private readonly deps: {
      git: GitService;
      staging: StagingService;
      commitContext: CommitContextBuilder;
      commitGenerator: CommitGenerator;
      tracker: UsageTracker;
      buildUsageEntry: UsageEntryBuilder;
      issueRefs: string[];
    },
  ) {}

  async run(): Promise<void> {
    while (true) {
      await this.deps.staging.ensureStaged();

      const files = this.deps.git.getStagedFileNames();
      const ctx = this.deps.commitContext.build(files);

      const startedAt = Date.now();

      let generated = await this.deps.commitGenerator.generate(files, ctx);
      let message = generated.message;
      let durationMs = Date.now() - startedAt;

      while (true) {
        const action = await UI.actionMenu(config);

        if (action === "commit") {
          this.commit(message, {
            files,
            diff: ctx._diff ?? "",
            usedTokens: generated.usage.totalTokens,
            usage: generated.usage,
            durationMs,
            fastMode: false,
          });
        }

        if (action === "regen") {
          this.deps.commitGenerator.extraInstruction = "";

          const regenStartedAt = Date.now();
          generated = await this.deps.commitGenerator.generate(files, ctx);
          durationMs = Date.now() - regenStartedAt;
          message = generated.message;

          continue;
        }

        if (action === "refine") {
          const text = await UI.refineInput(config);
          this.deps.commitGenerator.extraInstruction = text;

          const refineStartedAt = Date.now();
          generated = await this.deps.commitGenerator.generate(files, ctx);
          durationMs = Date.now() - refineStartedAt;
          message = generated.message;

          continue;
        }

        if (action === "edit") {
          message = await UI.editMessage(message, config);
          continue;
        }

        if (action === "copy") {
          await clipboard.write(message);
          UI.renderCopied();
          continue;
        }
        const selectedFiles = files
          .split("\n")
          .map((file) => file.trim())
          .filter(Boolean);
        this.deps.git.unstageFiles(selectedFiles);
        UI.renderCancelled();
        throw new UserCancelledError();
      }
    }
  }

  private appendIssueRefs(message: string): string {
    if (!this.deps.issueRefs.length) return message;

    return `${message}\n\nrefs ${this.deps.issueRefs.join(", ")}`;
  }

  private commit(
    message: string,
    meta: {
      files: string;
      diff: string;
      usedTokens: number;
      usage: GenerationUsage;
      durationMs: number;
      fastMode: boolean;
    },
  ): never {
    const finalMessage = this.appendIssueRefs(message);

    this.deps.git.createCommit(finalMessage);

    this.deps.tracker.record(
      this.deps.buildUsageEntry("commit", {
        files: meta.files,
        diff: meta.diff,
        usage: meta.usage,
        usedTokens: meta.usedTokens,
        durationMs: meta.durationMs,
        fastMode: meta.fastMode,
        success: true,
      }),
    );

    UI.renderCommitCreated(this.deps.git.getLastCommitStats());
    throw new GracefulExit(0);
  }
}
