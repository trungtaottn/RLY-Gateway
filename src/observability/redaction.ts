const sensitiveKey = /(?:authorization|api[-_]?key|token|secret|password|credential|prompt|response|email|account|system|input|content|body|payload|text|data|partial[-_]?json|message|signature|value)/i;

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return value.map((child) => redact(child, seen));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = sensitiveKey.test(key) ? "[REDACTED]" : redact(child, seen);
  }
  return output;
}
