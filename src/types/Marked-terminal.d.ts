declare module "marked-terminal" {
  import type { Renderer } from "marked";

  export default class TerminalRenderer extends Renderer {
    constructor(options?: Record<string, unknown>);
  }
}
