import OpenAI from "openai";
import type { LLM } from "./LLM.js";

const REASONING_MODEL = "gpt-4o-mini";
const GENERATION_MODEL = "gpt-4o-mini";

export class OpenAIProvider implements LLM {
  private readonly client: OpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async complete(prompt: string): Promise<string> {
    const response = await this.client.responses.create({
      model: REASONING_MODEL,
      input: prompt,
    });

    return response.output_text.trim();
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<string> {
    const stream = await this.client.responses.stream({
      model: GENERATION_MODEL,
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