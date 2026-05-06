import OpenAI from "openai";
import type { AppConfig } from "../config/config.js";
import type { LLM } from "./LLM.js";

export class OpenAIProvider implements LLM {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.client.responses.create({
      model: this.config.llm.reasoningModel,
      input: prompt,
    });

    return response.output_text.trim();
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<string> {
    const stream = await this.client.responses.stream({
      model: this.config.llm.generationModel,
      input: prompt,
    });

    let fullText = "";

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        fullText += event.delta;
        onText(fullText);
      }
    }

    return fullText.trim();
  }
}
