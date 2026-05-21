const MODEL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function normalizeModelName(name: unknown): string {
  const value = String(name ?? '').trim();
  if (!MODEL_NAME_PATTERN.test(value)) {
    throw new Error('Model name can only contain letters, numbers, underscores, and hyphens.');
  }
  return value;
}

export function isValidModelName(name: unknown): boolean {
  const value = String(name ?? '').trim();
  return value.length > 0 && MODEL_NAME_PATTERN.test(value);
}
