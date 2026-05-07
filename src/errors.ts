export class GracefulExit extends Error {
  constructor(
    public readonly code: number = 0,
    message?: string,
  ) {
    super(message ?? `Process exit with code ${code}`);
    this.name = "GracefulExit";
  }
}

export class UserCancelledError extends GracefulExit {
  constructor() {
    super(0);
    this.name = "UserCancelledError";
  }
}
