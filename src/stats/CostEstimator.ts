import type { UsageEntry, UsageLLMCall } from "../types/types.js";

export type TokenPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
};

export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd: number;
  totalUsd: number;
};

export class CostEstimator {
  private readonly prices: Record<string, TokenPrice> = {
    "openai:gpt-5.5": {
      inputPerMillion: 5,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30,
    },
    "openai:gpt-5.5-pro": {
      inputPerMillion: 30,
      outputPerMillion: 180,
    },
    "openai:gpt-5.4": {
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15,
    },
    "openai:gpt-5.4-mini": {
      inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 4.5,
    },
    "openai:gpt-5.4-nano": {
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.25,
    },
    "openai:gpt-5.4-pro": {
      inputPerMillion: 30,
      outputPerMillion: 180,
    },
    "openai:gpt-5.2": {
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14,
    },
    "openai:gpt-5.2-pro": {
      inputPerMillion: 21,
      outputPerMillion: 168,
    },
    "openai:gpt-5.1": {
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
    },
    "openai:gpt-5": {
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
    },
    "openai:gpt-5-mini": {
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 2,
    },
    "openai:gpt-5-nano": {
      inputPerMillion: 0.05,
      cachedInputPerMillion: 0.005,
      outputPerMillion: 0.4,
    },
    "openai:gpt-5-pro": {
      inputPerMillion: 15,
      outputPerMillion: 120,
    },
    "openai:gpt-4.1": {
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 8,
    },
    "openai:gpt-4.1-mini": {
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 1.6,
    },
    "openai:gpt-4.1-nano": {
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 0.4,
    },
    "openai:gpt-4o": {
      inputPerMillion: 2.5,
      cachedInputPerMillion: 1.25,
      outputPerMillion: 10,
    },
    "openai:gpt-4o-mini": {
      inputPerMillion: 0.15,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 0.6,
    },
    "openai:o4-mini": {
      inputPerMillion: 1.1,
      cachedInputPerMillion: 0.275,
      outputPerMillion: 4.4,
    },
    "openai:o3": {
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 8,
    },
    "openai:o3-mini": {
      inputPerMillion: 1.1,
      cachedInputPerMillion: 0.55,
      outputPerMillion: 4.4,
    },
    "openai:o3-pro": {
      inputPerMillion: 20,
      outputPerMillion: 80,
    },
    "openai:o1": {
      inputPerMillion: 15,
      cachedInputPerMillion: 7.5,
      outputPerMillion: 60,
    },
    "openai:o1-mini": {
      inputPerMillion: 1.1,
      cachedInputPerMillion: 0.55,
      outputPerMillion: 4.4,
    },
    "openai:o1-pro": {
      inputPerMillion: 150,
      outputPerMillion: 600,
    },
    "openai:gpt-4o-2024-05-13": {
      inputPerMillion: 5,
      outputPerMillion: 15,
    },
    "openai:gpt-4-turbo-2024-04-09": {
      inputPerMillion: 10,
      outputPerMillion: 30,
    },
    "openai:gpt-4-0125-preview": {
      inputPerMillion: 10,
      outputPerMillion: 30,
    },
    "openai:gpt-4-1106-preview": {
      inputPerMillion: 10,
      outputPerMillion: 30,
    },
    "openai:gpt-4-1106-vision-preview": {
      inputPerMillion: 10,
      outputPerMillion: 30,
    },
    "openai:gpt-4-0613": {
      inputPerMillion: 30,
      outputPerMillion: 60,
    },
    "openai:gpt-4-0314": {
      inputPerMillion: 30,
      outputPerMillion: 60,
    },
    "openai:gpt-4-32k": {
      inputPerMillion: 60,
      outputPerMillion: 120,
    },
    "openai:gpt-3.5-turbo": {
      inputPerMillion: 0.5,
      outputPerMillion: 1.5,
    },
    "openai:gpt-3.5-turbo-0125": {
      inputPerMillion: 0.5,
      outputPerMillion: 1.5,
    },
    "openai:gpt-3.5-turbo-1106": {
      inputPerMillion: 1,
      outputPerMillion: 2,
    },
    "openai:gpt-3.5-turbo-0613": {
      inputPerMillion: 1.5,
      outputPerMillion: 2,
    },
    "openai:gpt-3.5-0301": {
      inputPerMillion: 1.5,
      outputPerMillion: 2,
    },
    "openai:gpt-3.5-turbo-instruct": {
      inputPerMillion: 1.5,
      outputPerMillion: 2,
    },
    "openai:gpt-3.5-turbo-16k-0613": {
      inputPerMillion: 3,
      outputPerMillion: 4,
    },
    "openai:davinci-002": {
      inputPerMillion: 2,
      outputPerMillion: 2,
    },
    "openai:babbage-002": {
      inputPerMillion: 0.4,
      outputPerMillion: 0.4,
    },
  };

  estimateEntries(entries: UsageEntry[]): CostBreakdown {
    return this.sum(entries.map((entry) => this.estimateEntry(entry)));
  }

  estimateEntry(entry: UsageEntry): CostBreakdown {
    return this.sum((entry.llmCalls ?? []).map((call) => this.estimateCall(call)));
  }

  estimateCall(call: UsageLLMCall): CostBreakdown {
    if (call.provider === "ollama") {
      return this.zero();
    }

    const price = this.getPrice(call.provider, call.model);

    if (!price) {
      return this.zero();
    }

    const cachedTokens = call.tokens.cachedTokens ?? 0;
    const billableInputTokens = Math.max(
      0,
      call.tokens.inputTokens - cachedTokens,
    );

    const inputUsd =
      (billableInputTokens / 1_000_000) * price.inputPerMillion;

    const cachedInputUsd =
      (cachedTokens / 1_000_000) *
      (price.cachedInputPerMillion ?? price.inputPerMillion);

    const outputUsd =
      (call.tokens.outputTokens / 1_000_000) * price.outputPerMillion;

    return {
      inputUsd,
      outputUsd,
      cachedInputUsd,
      totalUsd: inputUsd + cachedInputUsd + outputUsd,
    };
  }

  hasPrice(provider: string, model: string): boolean {
    return Boolean(this.getPrice(provider, model));
  }

  private getPrice(provider: string, model: string): TokenPrice | undefined {
    return this.prices[`${provider}:${model}`];
  }

  private sum(items: CostBreakdown[]): CostBreakdown {
    return items.reduce(
      (total, item) => ({
        inputUsd: total.inputUsd + item.inputUsd,
        outputUsd: total.outputUsd + item.outputUsd,
        cachedInputUsd: total.cachedInputUsd + item.cachedInputUsd,
        totalUsd: total.totalUsd + item.totalUsd,
      }),
      this.zero(),
    );
  }

  private zero(): CostBreakdown {
    return {
      inputUsd: 0,
      outputUsd: 0,
      cachedInputUsd: 0,
      totalUsd: 0,
    };
  }
}
