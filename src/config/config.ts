export type LLMProviderName = "openai" | "ollama";

export interface AppConfig {
  app: {
    name: string;
    command: string;
  };

  llm: {
    provider: LLMProviderName;
    reasoningModel: string;
    generationModel: string;
  };

  git: {
    recentCommitCount: number;
    recentStyleCommitCount: number;
    largeDiffLineLimit: number;
    largeDiffHeaderLimit: number;
    maxRecentScopes: number;
    maxChangedSymbols: number;
    maxChangedSymbolLength: number;
    maxBufferBytes: number;
  };

  context: {
    fastModeFileLimit: number;
    fastModeTokenLimit: number;
    tokenBudget: number;
    smallFileThreshold: number;
    contextLines: number;
    maxFileBufferBytes: number;
    excludedContentPatterns: string[];
  };

  staging: {
    pageSize: number;
    loop: boolean;
    message: string;
    help: string;
  };

  commit: {
    summaryMaxLength: number;
    reasoningDiffPreviewLines: number;
    preferredBulletCount: number;
    maxBulletCount: number;
  };

  ui: {
    clearScreen: boolean;
    borderWidth: number;
    generatedCommitTitle: string;
    generatingPlaceholder: string;
    actionMenuMessage: string;
    refineMessage: string;
    editMessage: string;
    emptyInputMessage: string;
    actions: {
      commit: string;
      edit: string;
      regenerate: string;
      refine: string;
      copy: string;
      cancel: string;
    };
  };
}

export const config: AppConfig = {
  app: {
    name: "git-writer",
    command: "gw", // Must match the package.json bin command.
  },

  // LLM backend and models used by the two-pass generation flow.
  llm: {
    provider: "openai",
    reasoningModel: "gpt-4o-mini",
    generationModel: "gpt-5.4-mini",
  },

  // Git limits used while collecting repository metadata and diff context.
  git: {
    recentCommitCount: 8,
    recentStyleCommitCount: 12,
    largeDiffLineLimit: 800,
    largeDiffHeaderLimit: 150,
    maxRecentScopes: 10,
    maxChangedSymbols: 30,
    maxChangedSymbolLength: 120,
    maxBufferBytes: 10 * 1024 * 1024,
  },

  // Controls how much file content is sent to the LLM.
  context: {
    tokenBudget: 50_000,
    smallFileThreshold: 3_000,
    contextLines: 30,
    maxFileBufferBytes: 10 * 1024 * 1024,
    fastModeTokenLimit: 80_000,
    fastModeFileLimit: 50,
    excludedContentPatterns: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "dist/**",
      "build/**",
      "coverage/**",
      "*.min.js",
      "*.min.css",
    ],
  },

  // Interactive staging prompt behavior.
  staging: {
    pageSize: 25,
    loop: false,
    message: "Select files to stage",
    help: "↑/↓ move · Space select · Enter confirm",
  },

  // Commit message output constraints.
  commit: {
    summaryMaxLength: 72,
    reasoningDiffPreviewLines: 80,
    preferredBulletCount: 2,
    maxBulletCount: 3,
  },

  // UI labels and rendering options.
  ui: {
    clearScreen: true,
    borderWidth: 60,
    generatedCommitTitle: "Generated Commit",
    generatingPlaceholder: "...generating",
    actionMenuMessage: "What do you want to do?",
    refineMessage: "Refinement instruction",
    editMessage: "Edit commit message",
    emptyInputMessage: "Enter something",
    actions: {
      commit: " Commit",
      edit: " Edit message manually",
      regenerate: " Regenerate",
      refine: " Refine with instruction",
      copy: " Copy to clipboard",
      cancel: "✖ Cancel",
    },
  },
};
