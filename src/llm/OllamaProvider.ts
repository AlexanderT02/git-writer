import type { AppConfig } from "../config/config.js";
import type { LLM } from "./LLM.js";

export class OllamaProvider implements LLM {
  constructor(private readonly config: AppConfig) {}

  async complete(prompt: string): Promise<string> {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.llm.reasoningModel,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
    }

    const data = (await response.json()) as { response?: string };

    return (data.response ?? "").trim();
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<string> {
    const text = await this.complete(prompt);
    onText(text);
    return text;
  }
}
