// Pacchetti dell'orchestratore lasciati fuori dal bundle e copiati in node_modules accanto
// (build-orchestrator.mjs), e i pacchetti nativi per piattaforma. Usati anche dai controlli di
// package.mjs.

/** Fuori dal bundle: contengono binari o li cercano accanto a sé; zod è condiviso con l'SDK di Claude; tedious (SQL Server) porta le librerie di Azure, che il bundler non sa includere. */
export const EXTERNAL = ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'playwright-core', 'zod', 'tedious'];

/** Prefissi dei pacchetti nativi per piattaforma: se ne copia solo quello della piattaforma corrente. */
export const PLATFORM_PREFIXES = ['@anthropic-ai/claude-agent-sdk-', '@openai/codex-'];

export const platformPackages = (platform) => PLATFORM_PREFIXES.map((p) => `${p}${platform}`);
