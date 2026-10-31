// Modelli predefiniti del motore Claude (verificati sulla documentazione del 6 ottobre 2026):
// lead Claude Opus 5.5, worker Claude Sonnet 5.5. Identificativi esatti, senza suffissi di data.
export const DEFAULT_LEAD_MODEL = 'claude-opus-5-5';
export const DEFAULT_WORKER_MODEL = 'claude-sonnet-5-5';

/** "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-6" -> "Sonnet 4.6"; altrimenti il nome com'è. */
export function displayClaudeModel(model: string): string {
  const m = /^(?:[a-z]+\.)?claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:[-@].*)?$/i.exec(model.trim());
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}
