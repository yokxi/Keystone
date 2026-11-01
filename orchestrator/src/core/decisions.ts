// Coda delle decisioni che spettano all'utente: domande, permessi, merge.
//
// create() apre una decisione (salvata e inviata all'interfaccia). Chi la aspetta usa wait(id).
// answer() registra la scelta; l'orchestratore esegue gli effetti (es. il merge) e poi chiama
// settle(id) per svegliare chi aspetta. Le attese vivono solo in memoria: dopo un riavvio le
// decisioni aperte restano aperte e il team riprende la sessione dell'agente con la risposta.
import type { Decision, DecisionKind } from '@keystone/shared';
import type { Ctx } from './context.js';
import { DECISION_LIMIT } from './store.js';

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

export interface NewDecision {
  agentId: string;
  kind: DecisionKind;
  question: string;
  options: readonly string[];
  context?: string;
  taskId?: string;
  repoId?: string;
  worktree?: string;
  tool?: string;
  /** permesso: il comando completo */
  command?: string;
  /** permesso: richiede sempre approvazione (niente "Consenti sempre") */
  alwaysAsk?: boolean;
}

export class DecisionQueue {
  private waiters = new Map<string, Array<(d: Decision) => void>>();
  /** risposte registrate ma con effetti non ancora completati */
  private pending = new Set<string>();

  /** tempo già passato ad aspettare una risposta, per agente (ms), e attese in corso */
  private waitedDone = new Map<string, number>();
  private waitingSince = new Map<string, number[]>();

  constructor(private ctx: Ctx) {}

  /**
   * Quanto l'agente ha aspettato finora una risposta dell'utente (permessi, domande), comprese le
   * attese in corso. Serve a escludere le attese dal limite di tempo di un obiettivo.
   */
  waitedMs(agentId: string): number {
    const now = this.ctx.now();
    return (this.waitedDone.get(agentId) ?? 0) + (this.waitingSince.get(agentId) ?? []).reduce((s, t) => s + (now - t), 0);
  }

  private get all(): Decision[] {
    return this.ctx.store.data.decisions;
  }

  list(): readonly Decision[] {
    return this.all;
  }

  open(): Decision[] {
    return this.all.filter((d) => d.status === 'open');
  }

  get(id: string): Decision | undefined {
    return this.all.find((d) => d.id === id);
  }

  create(input: NewDecision): Decision {
    const question = input.question.trim();
    if (!question) throw new DecisionError('la domanda è vuota');
    const options = input.options.map((o) => o.trim()).filter(Boolean);
    if (input.kind !== 'question' && options.length === 0) throw new DecisionError(`una decisione "${input.kind}" richiede delle opzioni`);
    const d: Decision = {
      id: this.ctx.store.nextId('d'),
      agentId: input.agentId,
      kind: input.kind,
      question,
      options,
      status: 'open',
      createdAt: this.ctx.now(),
      ...(input.context ? { context: input.context } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.worktree ? { worktree: input.worktree } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.alwaysAsk !== undefined ? { alwaysAsk: input.alwaysAsk } : {}),
    };
    this.all.push(d);
    this.trim();
    this.changed(d);
    return d;
  }

  /**
   * Interpreta l'opzione scelta: etichetta (senza distinzione di maiuscole) oppure numero 1-based.
   * Restituisce l'etichetta esatta.
   */
  resolveOption(d: Decision, option: string | undefined): string | undefined {
    if (option === undefined || option.trim() === '') return undefined;
    const o = option.trim();
    const byLabel = d.options.find((x) => x.toLowerCase() === o.toLowerCase());
    if (byLabel) return byLabel;
    if (/^#?\d+$/.test(o)) {
      const n = Number(o.replace('#', ''));
      if (n >= 1 && n <= d.options.length) return d.options[n - 1];
    }
    throw new DecisionError(`opzione "${o}" non valida per ${d.id} (opzioni: ${d.options.join(' / ')})`);
  }

  /** Registra la risposta dell'utente. Gli effetti vanno applicati prima di settle(). */
  answer(id: string, option?: string, text?: string): Decision {
    const d = this.get(id);
    if (!d) throw new DecisionError(`la decisione ${id} non esiste`);
    if (d.status !== 'open') throw new DecisionError(`la decisione ${id} è già ${d.status === 'answered' ? 'risolta' : 'annullata'}`);
    const chosen = this.resolveOption(d, option);
    const note = text?.trim();
    if (d.kind !== 'question' && !chosen) throw new DecisionError(`scegli un'opzione per ${d.id}: ${d.options.join(' / ')}`);
    if (d.kind === 'question' && !chosen && !note) throw new DecisionError('la risposta è vuota');
    d.status = 'answered';
    d.answer = { ...(chosen ? { option: chosen } : {}), ...(note ? { text: note } : {}) };
    d.answeredAt = this.ctx.now();
    this.pending.add(d.id);
    this.changed(d);
    return d;
  }

  /**
   * Riapre una decisione risolta i cui effetti sono falliti (es. merge rifiutato perché il checkout
   * ha modifiche): l'utente può riprovare.
   */
  reopen(id: string, context?: string): Decision {
    const d = this.get(id);
    if (!d) throw new DecisionError(`la decisione ${id} non esiste`);
    d.status = 'open';
    delete d.answer;
    delete d.answeredAt;
    if (context) d.context = context;
    this.pending.delete(d.id);
    this.changed(d);
    return d;
  }

  /** Effetti completati: sveglia chi aspetta. */
  settle(id: string): void {
    this.pending.delete(id);
    const d = this.get(id);
    if (!d || d.status === 'open') return;
    const ws = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const w of ws) w(d);
  }

  /** Annulla una decisione aperta (es. il turno dell'agente è stato fermato). */
  cancel(id: string, reason: string): void {
    const d = this.get(id);
    if (!d || d.status !== 'open') return;
    d.status = 'cancelled';
    d.cancelReason = reason;
    this.changed(d);
    this.settle(id);
  }

  /** Attende che la decisione sia risolta (con effetti completati) o annullata. */
  wait(id: string): Promise<Decision> {
    const d = this.get(id);
    if (!d) return Promise.reject(new DecisionError(`la decisione ${id} non esiste`));
    if (d.status !== 'open' && !this.pending.has(id)) return Promise.resolve(d);
    const agentId = d.agentId;
    const start = this.ctx.now();
    const since = this.waitingSince.get(agentId) ?? [];
    since.push(start);
    this.waitingSince.set(agentId, since);
    return new Promise((resolve) => {
      const ws = this.waiters.get(id) ?? [];
      ws.push((v) => {
        const list = this.waitingSince.get(agentId) ?? [];
        const i = list.indexOf(start);
        if (i >= 0) list.splice(i, 1);
        this.waitedDone.set(agentId, (this.waitedDone.get(agentId) ?? 0) + (this.ctx.now() - start));
        resolve(v);
      });
      this.waiters.set(id, ws);
    });
  }

  hasWaiters(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }

  /** Tiene al massimo DECISION_LIMIT decisioni, eliminando le più vecchie già chiuse. */
  private trim(): void {
    let excess = this.all.length - DECISION_LIMIT;
    if (excess <= 0) return;
    for (let i = 0; i < this.all.length && excess > 0; ) {
      if (this.all[i]!.status !== 'open') {
        this.all.splice(i, 1);
        excess--;
      } else i++;
    }
  }

  private changed(d: Decision): void {
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'decision.upsert', decision: { ...d, options: [...d.options] } });
  }
}
