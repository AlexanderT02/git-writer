import chalk from "chalk";
import OpenAI from "openai";

export class OpenAIClient {
  static REASONING_MODEL = "gpt-5.5";
  static GENERATION_MODEL = "gpt-5.4-nano";

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      console.log(chalk.red.bold("\n✖ OPENAI_API_KEY not set\n"));
      process.exit(1);
    }

    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async complete(prompt, model = OpenAIClient.REASONING_MODEL) {
    const response = await this.client.responses.create({
      model,
      input: prompt,
    });

    return (response.output_text || "").trim();
  }

  async streamCompletion(
    prompt,
    onToken,
    model = OpenAIClient.GENERATION_MODEL,
  ) {
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