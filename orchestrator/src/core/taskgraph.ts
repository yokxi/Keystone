// Grafo dei task: dipendenze, stati, assegnazione, avanzamento degli obiettivi.
//
// Regole:
//  - le dipendenze devono esistere, niente auto-dipendenze né cicli (controllo su create e update)
//  - un task passa a "doing" solo se ha un assegnatario e tutte le dipendenze sono "done"
//  - un task con un worktree diventa "done" solo tramite merge approvato (opzione `merged`)
//  - "done" e "cancelled" sono terminali per lo scheduler, ma un retry li riporta a "todo"
import type { CiStatus, Task, TaskStatus } from '@keystone/shared';
import type { Ctx } from './context.js';

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface NewTask {
  title: string;
  description?: string;
  deps?: string[];
  assignee?: string;
  priority?: number;
  goalId?: string;
  repoId?: string;
  createdBy: string;
}

export interface TaskChanges {
  title?: string;
  description?: string;
  deps?: string[];
  /** null toglie l'assegnatario */
  assignee?: string | null;
  priority?: number;
  repoId?: string;
  branch?: string;
  worktree?: string | null;
  ci?: CiStatus;
  summary?: string;
}

/** Stati raggiungibili da ciascuno stato. */
const ALLOWED: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['doing', 'blocked', 'cancelled', 'done']),
  doing: new Set(['review', 'blocked', 'todo', 'cancelled', 'done']),
  review: new Set(['done', 'doing', 'blocked', 'todo', 'cancelled']),
  blocked: new Set(['todo', 'doing', 'review', 'cancelled']),
  done: new Set(['todo']),
  cancelled: new Set(['todo']),
};

/** Peso di ogni stato nell'avanzamento di un obiettivo. */
const PROGRESS_WEIGHT: Record<TaskStatus, number> = { todo: 0, blocked: 0, doing: 0.4, review: 0.75, done: 1, cancelled: 0 };

export class TaskGraph {
  constructor(private ctx: Ctx) {}

  private get all(): Task[] {
    return this.ctx.store.data.tasks;
  }

  list(): readonly Task[] {
    return this.all;
  }

  get(id: string): Task | undefined {
    return this.all.find((t) => t.id === id);
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new TaskError(`il task ${id} non esiste`);
    return t;
  }

  ofGoal(goalId: string): Task[] {
    return this.all.filter((t) => t.goalId === goalId);
  }

  create(input: NewTask): Task {
    const title = input.title.trim();
    if (!title) throw new TaskError('il titolo del task è vuoto');
    const deps = this.checkDeps(undefined, input.deps ?? []);
    const now = this.ctx.now();
    const task: Task = {
      id: this.ctx.store.nextId('t'),
      title,
      status: 'todo',
      deps,
      priority: input.priority ?? 0,
      ci: 'unknown',
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      ...(input.description ? { description: input.description } : {}),
      ...(input.assignee ? { assignee: input.assignee } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.repoId ? { repoId: input.repoId } : {}),
    };
    this.all.push(task);
    this.changed(task);
    return task;
  }

  /** Modifica i campi che non sono lo stato. */
  update(id: string, changes: TaskChanges): Task {
    const t = this.require(id);
    if (changes.deps) t.deps = this.checkDeps(id, changes.deps);
    if (changes.title !== undefined) {
      if (!changes.title.trim()) throw new TaskError('il titolo del task è vuoto');
      t.title = changes.title.trim();
    }
    if (changes.description !== undefined) t.description = changes.description;
    if (changes.priority !== undefined) t.priority = changes.priority;
    if (changes.repoId !== undefined) t.repoId = changes.repoId;
    if (changes.branch !== undefined) t.branch = changes.branch;
    if (changes.ci !== undefined) t.ci = changes.ci;
    if (changes.summary !== undefined) t.summary = changes.summary;
    if (changes.assignee === null) delete t.assignee;
    else if (changes.assignee !== undefined) t.assignee = changes.assignee;
    if (changes.worktree === null) delete t.worktree;
    else if (changes.worktree !== undefined) t.worktree = changes.worktree;
    this.changed(t);
    return t;
  }

  /** Motivo per cui il task non può passare a `to`, oppure undefined se può. */
  whyNot(t: Task, to: TaskStatus): string | undefined {
    if (t.status === to) return undefined;
    if (!ALLOWED[t.status].has(to)) return `${t.id} non può passare da ${t.status} a ${to}`;
    if (to === 'doing') {
      if (!t.assignee) return `${t.id} non ha un assegnatario`;
      const open = this.unmetDeps(t);
      if (open.length) return `${t.id} aspetta ${open.join(', ')}`;
    }
    return undefined;
  }

  setStatus(id: string, to: TaskStatus, opts: { reason?: string; summary?: string; merged?: boolean; force?: boolean } = {}): Task {
    const t = this.require(id);
    if (!opts.force) {
      const why = this.whyNot(t, to);
      if (why) throw new TaskError(why);
      if (to === 'done' && t.worktree && !opts.merged) throw new TaskError(`${t.id} ha un worktree: diventa "done" solo con un merge approvato`);
    }
    t.status = to;
    if (to === 'blocked') t.blockedReason = opts.reason ?? t.blockedReason ?? 'bloccato';
    else delete t.blockedReason;
    if (opts.summary) t.summary = opts.summary;
    this.changed(t);
    return t;
  }

  unmetDeps(t: Task): string[] {
    return t.deps.filter((d) => this.get(d)?.status !== 'done');
  }

  /** Task pronti a partire: "todo" con dipendenze completate; priorità alta prima, poi i più vecchi. */
  ready(goalId?: string): Task[] {
    return this.all
      .filter((t) => t.status === 'todo' && (!goalId || t.goalId === goalId) && this.unmetDeps(t).length === 0)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || idOrder(a.id, b.id));
  }

  dependents(id: string): Task[] {
    return this.all.filter((t) => t.deps.includes(id));
  }

  /** Dare a `id` queste dipendenze creerebbe un ciclo? */
  wouldCycle(id: string, deps: string[]): boolean {
    const visited = new Set<string>();
    const todo = [...deps];
    while (todo.length) {
      const cur = todo.pop()!;
      if (cur === id) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      todo.push(...(this.get(cur)?.deps ?? []));
    }
    return false;
  }

  /** Avanzamento dell'obiettivo in 0..1 (i task annullati non contano). */
  progress(goalId: string): number {
    const ts = this.ofGoal(goalId).filter((t) => t.status !== 'cancelled');
    if (!ts.length) return 0;
    const sum = ts.reduce((s, t) => s + PROGRESS_WEIGHT[t.status], 0);
    return Math.round((sum / ts.length) * 1000) / 1000;
  }

  /** Tutti i task non annullati dell'obiettivo sono "done". */
  goalComplete(goalId: string): boolean {
    const ts = this.ofGoal(goalId).filter((t) => t.status !== 'cancelled');
    return ts.length > 0 && ts.every((t) => t.status === 'done');
  }

  private checkDeps(id: string | undefined, deps: string[]): string[] {
    const unique = [...new Set(deps.map((d) => d.trim()).filter(Boolean))];
    for (const d of unique) {
      if (d === id) throw new TaskError(`${id} non può dipendere da se stesso`);
      if (!this.get(d)) throw new TaskError(`dipendenza sconosciuta: ${d}`);
    }
    if (id && this.wouldCycle(id, unique)) throw new TaskError(`le dipendenze di ${id} creerebbero un ciclo`);
    return unique;
  }

  private changed(t: Task): void {
    t.updatedAt = this.ctx.now();
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'task.upsert', task: { ...t, deps: [...t.deps] } });
  }
}

function idOrder(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}
