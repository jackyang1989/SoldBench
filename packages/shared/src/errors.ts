export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, 400, message);
}
