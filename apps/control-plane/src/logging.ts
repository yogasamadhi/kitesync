export interface SafeErrorLog {
  name: string;
  message: string;
  code?: string;
}

export function safeErrorLog(error: unknown): SafeErrorLog {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: 'Unexpected non-Error value was thrown' };
  }
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' ? { code } : {}),
  };
}
