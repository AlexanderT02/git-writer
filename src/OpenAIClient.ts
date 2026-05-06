import chalk from "chalk";
import OpenAI from "openai";
import type { AIClient } from "./types.js";

export class OpenAIClient implements AIClient {
  static readonly REASONING_MODEL = "gpt-5.5";
  static readonly GENERATION_MODEL = "gpt-5.4-nano";

  private readonly client: OpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      console.log(chalk.red.bold("\n✖ OPENAI_API_KEY not set\n"));
      process.exit(1);
    }

    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async complete(
    prompt: string,
    model = OpenAIClient.REASONING_MODEL,
  ): Promise<string> {
    const response = await this.client.responses.create({
      model,
      input: prompt,
    });

    return (response.output_text || "").trim();
  }

  async streamCompletion(
    prompt: string,
    onToken: (text: string) => void,
    model = OpenAIClient.GENERATION_MODEL,
  ): Promise<string> {
    const stream = await this.client.responses.stream({
      model,
      input: prompt,
    });

    let fullText = "";

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        fullText += event.delta;
        onToken(fullText);
      }
    }

    return fullText.trim();
  }
}