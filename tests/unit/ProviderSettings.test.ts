import { beforeEach, describe, expect, it, vi } from "vitest";

const fileStore = new Map<string, string>();
const mkdirSyncMock = vi.fn();

vi.mock("os", () => ({
  homedir: () => "/mock-home",
}));

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");

  return {
    ...actual,
    join: (...parts: string[]) => parts.join("/"),
  };
});

vi.mock("fs", () => ({
  existsSync: vi.fn((path: string) => fileStore.has(path)),
  mkdirSync: mkdirSyncMock,
  readFileSync: vi.fn((path: string) => {
    const value = fileStore.get(path);

    if (value === undefined) {
      throw new Error(`File not found: ${path}`);
    }

    return value;
  }),
  writeFileSync: vi.fn((path: string, data: string) => {
    fileStore.set(path, data);
  }),
}));

vi.mock("../src/config/config.js", () => ({
  config: {
    llm: {
      defaultProvider: "openai",
      providers: {
        openai: {
          reasoningModel: "gpt-4o-mini",
          generationModel: "gpt-5.4-mini",
        },
        ollama: {
          reasoningModel: "llama3.1",
          generationModel: "llama3.1",
        },
        gemini: {
          reasoningModel: "gemini-2.5-flash",
          generationModel: "gemini-2.5-flash-lite",
        },
      },
    },
  },
}));

const CONFIG_FILE = "/mock-home/.git-writer/config.json";

describe("ProviderSettings", () => {
  beforeEach(() => {
    fileStore.clear();
    mkdirSyncMock.mockClear();
  });

  it("returns default provider when no settings file exists", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrentProvider()).toBe("openai");
  });

  it("returns default provider config when no settings file exists", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrent()).toEqual({
      provider: "openai",
      reasoningModel: "gpt-4o-mini",
      generationModel: "gpt-5.4-mini",
    });
  });

  it("returns stored provider and models when settings file exists", async () => {
    fileStore.set(
      CONFIG_FILE,
      JSON.stringify({
        provider: "gemini",
        reasoningModel: "custom-reasoning",
        generationModel: "custom-generation",
      }),
    );

    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrent()).toEqual({
      provider: "gemini",
      reasoningModel: "custom-reasoning",
      generationModel: "custom-generation",
    });
  });

  it("falls back to configured provider models when stored models are missing", async () => {
    fileStore.set(
      CONFIG_FILE,
      JSON.stringify({
        provider: "gemini",
      }),
    );

    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrent()).toEqual({
      provider: "gemini",
      reasoningModel: "gemini-2.5-flash",
      generationModel: "gemini-2.5-flash-lite",
    });
  });

  it("falls back to default provider when stored provider is invalid", async () => {
    fileStore.set(
      CONFIG_FILE,
      JSON.stringify({
        provider: "invalid-provider",
        reasoningModel: "bad-reasoning",
        generationModel: "bad-generation",
      }),
    );

    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrent()).toEqual({
      provider: "openai",
      reasoningModel: "gpt-4o-mini",
      generationModel: "gpt-5.4-mini",
    });
  });

  it("sets provider and writes matching default models", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    settings.setProvider("gemini");

    expect(mkdirSyncMock).toHaveBeenCalledWith("/mock-home/.git-writer", {
      recursive: true,
    });

    expect(JSON.parse(fileStore.get(CONFIG_FILE) ?? "{}")).toEqual({
      provider: "gemini",
      reasoningModel: "gemini-2.5-flash",
      generationModel: "gemini-2.5-flash-lite",
    });
  });

  it("preserves unrelated stored settings when setting provider", async () => {
    fileStore.set(
      CONFIG_FILE,
      JSON.stringify({
        provider: "openai",
        customSetting: true,
      }),
    );

    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    settings.setProvider("ollama");

    expect(JSON.parse(fileStore.get(CONFIG_FILE) ?? "{}")).toEqual({
      provider: "ollama",
      customSetting: true,
      reasoningModel: "llama3.1",
      generationModel: "llama3.1",
    });
  });

  it("throws when setting an invalid provider", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(() => settings.setProvider("invalid" as any)).toThrow(
      'Invalid provider "invalid". Expected one of: openai, ollama, gemini',
    );
  });

  it("returns available providers", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.availableProviders()).toEqual([
      "openai",
      "ollama",
      "gemini",
    ]);
  });

  it("checks whether a value is a valid provider name", async () => {
    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.isProviderName("openai")).toBe(true);
    expect(settings.isProviderName("ollama")).toBe(true);
    expect(settings.isProviderName("gemini")).toBe(true);
    expect(settings.isProviderName("invalid")).toBe(false);
  });

  it("returns defaults when the settings file contains invalid JSON", async () => {
    fileStore.set(CONFIG_FILE, "{ invalid json");

    const { ProviderSettings } = await import("../../src/llm/ProviderSettings.js");

    const settings = new ProviderSettings();

    expect(settings.getCurrent()).toEqual({
      provider: "openai",
      reasoningModel: "gpt-4o-mini",
      generationModel: "gpt-5.4-mini",
    });
  });
});