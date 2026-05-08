import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { config } from "../config/config.js";
import type { LLMProviderName } from "../config/config.js";

type StoredSettings = {
  provider?: LLMProviderName;
  reasoningModel?: string;
  generationModel?: string;
};

const CONFIG_DIR = join(homedir(), ".git-writer");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export const PROVIDER_CONFIG_FILE = CONFIG_FILE;

export class ProviderSettings {
  getCurrentProvider(): LLMProviderName {
    return this.getCurrent().provider;
  }

  getCurrent(): {
    provider: LLMProviderName;
    reasoningModel: string;
    generationModel: string;
  } {
    const stored = this.read();

    if (stored.provider && this.isProviderName(stored.provider)) {
      const fallback = config.llm.providers[stored.provider];

      return {
        provider: stored.provider,
        reasoningModel: stored.reasoningModel ?? fallback.reasoningModel,
        generationModel: stored.generationModel ?? fallback.generationModel,
      };
    }

    const defaultProvider = config.llm.defaultProvider;
    const fallback = config.llm.providers[defaultProvider];

    return {
      provider: defaultProvider,
      reasoningModel: fallback.reasoningModel,
      generationModel: fallback.generationModel,
    };
  }

  setProvider(provider: LLMProviderName): void {
    if (!this.isProviderName(provider)) {
      throw new Error(
        `Invalid provider "${provider}". Expected one of: ${this.availableProviders().join(", ")}`,
      );
    }

    const providerConfig = config.llm.providers[provider];

    mkdirSync(CONFIG_DIR, { recursive: true });

    writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          ...this.read(),
          provider,
          reasoningModel: providerConfig.reasoningModel,
          generationModel: providerConfig.generationModel,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  availableProviders(): LLMProviderName[] {
    return Object.keys(config.llm.providers) as LLMProviderName[];
  }

  isProviderName(value: string): value is LLMProviderName {
    return this.availableProviders().includes(value as LLMProviderName);
  }

  private read(): StoredSettings {
    if (!existsSync(CONFIG_FILE)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StoredSettings;
    } catch {
      return {};
    }
  }
}
