// Skill: file markdown di regole per gli agenti (Fase Skill).
//
// Due posti: `.keystone/skills/` nel repository (condivise con il team tramite git, lette dal
// branch di destinazione) e `~/.keystone/skills/` (personali). Il formato è un'intestazione tra
// due righe `---` con chiavi in italiano, poi il testo della regola:
//
//   ---
//   nome: Messaggi di commit
//   descrizione: come scrivere i messaggi di commit
//   per: worker            (lead | worker | tutti)
//   quando: lavoro         (sempre | piano | lavoro | review, anche più d'uno separati da virgole)
//   file: src/api/**, *.sql   (facoltativo: vale solo se il lavoro tocca questi file)
//   attiva: sì             (sì | no)
//   ---
//   Testo della regola…
//
// Qui ci sono solo funzioni pure (lettura, scrittura, applicabilità), usate dall'orchestratore e
// dall'interfaccia.
import { z } from 'zod';

export const SKILL_LIMITS = {
  /** caratteri del testo di una skill */
  bodyChars: 8000,
  /** dimensione massima del file (intestazione compresa) */
  fileBytes: 12_000,
  /** skill lette al massimo per ogni posto (repository o personali) */
  perSource: 50,
  /** caratteri di skill consegnati al massimo in un turno */
  deliveredChars: 24_000,
  /** schemi di file per skill */
  globs: 20,
} as const;

/** Nome del file senza `.md`: minuscole, cifre e trattini. */
export const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** Cartella delle skill del repository, relativa alla radice. */
export const REPO_SKILLS_DIR = '.keystone/skills';

export const SkillAudience = z.enum(['lead', 'worker', 'tutti']);
export type SkillAudience = z.infer<typeof SkillAudience>;
export const SkillPhase = z.enum(['sempre', 'piano', 'lavoro', 'review']);
export type SkillPhase = z.infer<typeof SkillPhase>;
export const SkillSource = z.enum(['repo', 'personal']);
export type SkillSource = z.infer<typeof SkillSource>;

const Glob = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((g) => !/[\r\n,]/.test(g), 'uno schema per voce, senza virgole');

/** Il contenuto di una skill (quello che sta nel file). */
export const SkillDraft = z.object({
  name: z.string().trim().min(1).max(100).refine((s) => !/[\r\n]/.test(s), 'una riga sola'),
  description: z.string().trim().max(300).refine((s) => !/[\r\n]/.test(s), 'una riga sola').optional(),
  appliesTo: SkillAudience,
  when: z.array(SkillPhase).min(1).max(4),
  files: z.array(Glob).max(SKILL_LIMITS.globs),
  enabled: z.boolean(),
  body: z.string().trim().min(1).max(SKILL_LIMITS.bodyChars),
});
export type SkillDraft = z.infer<typeof SkillDraft>;

/**
 * Una skill come la vede l'interfaccia. Per quelle del repository conta la versione sul branch di
 * destinazione (quella che ricevono gli agenti); `pending` dice se nel tuo checkout c'è una
 * versione diversa, ancora da committare, e `local` è quella versione.
 */
export const Skill = z.object({
  id: z.string().regex(SKILL_ID_RE),
  source: SkillSource,
  /** solo per le skill del repository */
  repoId: z.string().max(200).optional(),
  /** il branch da cui è stata letta (skill del repository) */
  branch: z.string().max(250).optional(),
  /** contenuto valido: assente se il file non si legge (vedi error) */
  draft: SkillDraft.optional(),
  error: z.string().max(500).optional(),
  /** attivazione locale (solo tua, non nel file): assente = vale "attiva" del file */
  override: z.boolean().optional(),
  /** la skill viene consegnata agli agenti (valida, attiva, sul branch o personale) */
  effective: z.boolean(),
  /** nel tuo checkout: new = solo lì, modified = diversa dal branch, deleted = cancellata lì */
  pending: z.enum(['new', 'modified', 'deleted']).optional(),
  local: SkillDraft.optional(),
  localError: z.string().max(500).optional(),
  /**
   * Solo personali: il file non è quello salvato o confermato da te nell'app (creato o cambiato da
   * fuori). Gli agenti non lo ricevono finché non lo confermi; il valore è l'impronta (SHA-256) del
   * contenuto attuale, da rimandare con skill.confirm.
   */
  unconfirmed: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type Skill = z.infer<typeof Skill>;

/** Una skill consegnata a un agente in un turno (pannello dell'agente). */
export const SkillRef = z.object({ id: z.string().regex(SKILL_ID_RE), source: SkillSource, name: z.string().max(100) });
export type SkillRef = z.infer<typeof SkillRef>;

// ---- file ------------------------------------------------------------------------------------

const KEYS: Record<string, keyof SkillDraft> = { nome: 'name', descrizione: 'description', per: 'appliesTo', quando: 'when', file: 'files', attiva: 'enabled' };
const YES = new Set(['sì', 'si', 'true']);
const NO = new Set(['no', 'false']);

export type SkillParse = { ok: true; draft: SkillDraft } | { ok: false; error: string };

/** Legge un file di skill. Chiavi sconosciute o ripetute, valori non validi: errore. */
export function parseSkillFile(text: string): SkillParse {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) return { ok: false, error: "manca l'intestazione tra due righe ---" };
  const raw: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) return { ok: false, error: `riga dell'intestazione non valida: "${line.slice(0, 60)}"` };
    const key = line.slice(0, i).trim().toLowerCase();
    if (!(key in KEYS)) return { ok: false, error: `chiave sconosciuta: "${key.slice(0, 40)}" (ammesse: ${Object.keys(KEYS).join(', ')})` };
    if (key in raw) return { ok: false, error: `chiave ripetuta: ${key}` };
    raw[key] = line.slice(i + 1).trim();
  }
  if (!raw.nome) return { ok: false, error: 'manca il nome' };
  const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const enabledRaw = (raw.attiva ?? 'sì').toLowerCase();
  if (!YES.has(enabledRaw) && !NO.has(enabledRaw)) return { ok: false, error: `"attiva" vale sì o no, non "${enabledRaw.slice(0, 20)}"` };
  const candidate = {
    name: raw.nome,
    ...(raw.descrizione ? { description: raw.descrizione } : {}),
    appliesTo: (raw.per ?? 'tutti').toLowerCase(),
    when: raw.quando ? list(raw.quando.toLowerCase()) : ['sempre'],
    files: list(raw.file),
    enabled: YES.has(enabledRaw),
    body: m[2]!,
  };
  const r = SkillDraft.safeParse(candidate);
  if (!r.success) {
    const i = r.error.issues[0]!;
    const field = Object.entries(KEYS).find(([, v]) => v === i.path[0])?.[0] ?? (i.path[0] === 'body' ? 'testo' : String(i.path[0] ?? ''));
    return { ok: false, error: `${field}: ${field === 'testo' && !candidate.body.trim() ? 'vuoto' : i.message}` };
  }
  return { ok: true, draft: r.data };
}

/** Scrive il file di una skill (il formato che parseSkillFile rilegge uguale). */
export function serializeSkill(d: SkillDraft): string {
  const lines = ['---', `nome: ${d.name}`];
  if (d.description) lines.push(`descrizione: ${d.description}`);
  lines.push(`per: ${d.appliesTo}`, `quando: ${d.when.join(', ')}`);
  if (d.files.length) lines.push(`file: ${d.files.join(', ')}`);
  lines.push(`attiva: ${d.enabled ? 'sì' : 'no'}`, '---', '', d.body.trim(), '');
  return lines.join('\n');
}

export function sameDraft(a: SkillDraft | undefined, b: SkillDraft | undefined): boolean {
  return !!a && !!b && serializeSkill(a) === serializeSkill(b);
}

// ---- a chi e quando si applica -------------------------------------------------------------------

/**
 * Un nome (segmento senza `/`) corrisponde a un pezzo di schema con `*` e `?`? Programmazione
 * dinamica, tempo proporzionale a lunghezza dello schema × lunghezza del nome: niente espressioni
 * regolari, che con schemi scelti apposta possono metterci un tempo esponenziale.
 */
function segmentMatches(pat: string, name: string): boolean {
  let prev = new Array<boolean>(name.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= pat.length; i++) {
    const c = pat[i - 1]!;
    const cur = new Array<boolean>(name.length + 1).fill(false);
    cur[0] = c === '*' && prev[0]!;
    for (let j = 1; j <= name.length; j++) {
      if (c === '*') cur[j] = prev[j]! || cur[j - 1]!;
      else cur[j] = prev[j - 1]! && (c === '?' || c === name[j - 1]);
    }
    prev = cur;
  }
  return prev[name.length]!;
}

/** Il percorso (in segmenti) corrisponde allo schema (in segmenti)? `**` = zero o più cartelle. */
function pathMatches(pat: readonly string[], segs: readonly string[]): boolean {
  // ok[i][j]: i primi i pezzi dello schema corrispondono ai primi j segmenti del percorso
  let prev = new Array<boolean>(segs.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= pat.length; i++) {
    const p = pat[i - 1]!;
    const cur = new Array<boolean>(segs.length + 1).fill(false);
    if (p === '**') {
      cur[0] = prev[0]!;
      for (let j = 1; j <= segs.length; j++) cur[j] = prev[j]! || cur[j - 1]!;
    } else {
      for (let j = 1; j <= segs.length; j++) cur[j] = prev[j - 1]! && segmentMatches(p, segs[j - 1]!);
    }
    prev = cur;
  }
  return prev[segs.length]!;
}

function splitPath(p: string): string[] {
  return p.replace(/\\/g, '/').toLowerCase().split('/').filter((s) => s && s !== '.');
}

/** Pezzi di uno schema: `**` consecutivi ridotti a uno, `**` dentro un nome vale come `*`. */
function splitGlob(g: string): string[] {
  const out: string[] = [];
  for (const s of splitPath(g)) {
    const seg = s === '**' ? s : s.replace(/\*+/g, '*');
    if (seg === '**' && out[out.length - 1] === '**') continue;
    out.push(seg);
  }
  return out;
}

/**
 * Un percorso (relativo alla radice del repository) corrisponde a uno degli schemi? `**` vale per
 * zero o più cartelle, `*` e `?` dentro un nome. Uno schema senza `/` vale per il nome del file in
 * qualsiasi cartella (es. `*.sql`). Maiuscole e minuscole non contano: meglio una regola in più che
 * una in meno.
 */
export function matchesGlob(globs: readonly string[], file: string): boolean {
  const segs = splitPath(file);
  if (!segs.length) return false;
  return globs.some((g) => {
    const pat = splitGlob(g);
    if (!pat.length) return false;
    return g.includes('/') || g.includes('\\') ? pathMatches(pat, segs) : pathMatches(pat, segs.slice(-1));
  });
}

/** Parole di un testo che sembrano percorsi di file (con una `/` o un'estensione). */
export function pathsInText(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.split(/[\s"'`()[\]{}<>,;]+/)) {
    const t = w.replace(/[.:!?]+$/, '');
    if (t.length < 3 || t.length > 300) continue;
    if (/[\\/]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t)) out.add(t.replace(/\\/g, '/'));
  }
  return [...out];
}

export interface SkillContext {
  role: 'lead' | 'worker';
  phase: Exclude<SkillPhase, 'sempre'>;
  /** file toccati dal lavoro (relativi alla radice del repository) */
  files: readonly string[];
  /** la richiesta: obiettivo o task */
  text: string;
}

/** La skill (già valida e attiva) vale per questo turno? */
export function skillApplies(d: SkillDraft, ctx: SkillContext): boolean {
  if (d.appliesTo !== 'tutti' && d.appliesTo !== ctx.role) return false;
  if (!d.when.includes('sempre') && !d.when.includes(ctx.phase)) return false;
  if (!d.files.length) return true;
  return [...ctx.files, ...pathsInText(ctx.text)].some((f) => matchesGlob(d.files, f));
}

/** Un id libero per una skill nuova, dal nome. */
export function skillIdFromName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '') || 'skill';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
