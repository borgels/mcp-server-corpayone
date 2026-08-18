/**
 * Some MCP clients stringify object-typed tool arguments when the input schema
 * does not advertise `type: "object"`. Recover the intended object or array so
 * it is not sent to Corpay as a JSON string literal, which the API rejects.
 */
export function normalizeJsonBody<T>(value: T): T {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return value;
  }
}
