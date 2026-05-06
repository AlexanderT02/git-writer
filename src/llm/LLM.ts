export interface LLM {
  complete(prompt: string): Promise<string>;

  stream(
    prompt: string,
    onText: (text: string) => void,
  ): Promise<string>;
}
