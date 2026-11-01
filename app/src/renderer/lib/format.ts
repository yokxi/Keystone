import type { AgentState, TaskStatus } from '@keystone/shared';

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'libero',
  thinking: 'ragiona',
  reading: 'legge',
  editing: 'modifica',
  running: 'esegue',
  testing: 'test',
  waiting_user: 'aspetta te',
  blocked: 'bloccato',
  done: 'finito',
  error: 'errore',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Da fare',
  doing: 'In corso',
  review: 'In review',
  blocked: 'Bloccati',
  done: 'Completati',
  cancelled: 'Annullati',
};

/**
 * Come chiamare la spesa. Con l'abbonamento (login personale) si paga il piano, non i token: la
 * cifra è una stima di quanto costerebbe via API.
 */
export function spendLabel(billing: 'api' | 'subscription' | undefined, costIncomplete = false): { word: string; suffix: string; title: string } {
  const partial = costIncomplete ? ' · Codex: solo token' : '';
  const partialTitle = costIncomplete ? '. Codex riporta solo token: il suo consumo non è compreso nella cifra (vedi i token)' : '';
  if (billing === 'subscription')
    return { word: 'stima', suffix: ` · abbonamento${partial}`, title: `Stima di quanto costerebbe via API: con l'abbonamento non si paga a consumo${partialTitle}` };
  return { word: 'costo', suffix: partial, title: `Costo totale${partialTitle}` };
}

/** Limiti di turni e di tempo di un obiettivo, se ci sono: " · turni 3/30 · 2/60 min". */
export function goalLimitsText(goal: { turnLimit?: number; turnsUsed?: number; minuteLimit?: number; activeMs?: number }): string {
  const parts: string[] = [];
  if (goal.turnLimit !== undefined) parts.push(`turni ${goal.turnsUsed ?? 0}/${goal.turnLimit}`);
  if (goal.minuteLimit !== undefined) parts.push(`${Math.floor((goal.activeMs ?? 0) / 60_000)}/${goal.minuteLimit} min`);
  return parts.map((p) => ` · ${p}`).join('');
}

export function money(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s fa`;
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  return `${Math.round(s / 3600)} h fa`;
}
