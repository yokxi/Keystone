// Messaggi tra agenti e con l'utente, più il feed delle attività.
//
// Un agente legge i messaggi non letti a lui indirizzati (o a "all"): l'orchestratore li allega
// al risultato di ogni tool del team, così arrivano anche a metà turno, e al prompt del turno
// successivo.
import type { FeedItem, FeedKind } from '@keystone/shared';
import { truncate } from '../util/text.js';
import type { Ctx } from './context.js';
import type { BusMessage } from './store.js';

export class MessageBus {
  private listeners: Array<(m: BusMessage) => void> = [];

  constructor(private ctx: Ctx) {}

  feed(kind: FeedKind, text: string, extra: { agentId?: string; to?: string } = {}): FeedItem {
    const item: FeedItem = { ts: this.ctx.now(), kind, text: truncate(text, 500), ...(extra.agentId ? { agentId: extra.agentId } : {}), ...(extra.to ? { to: extra.to } : {}) };
    this.ctx.store.pushFeed(item);
    this.ctx.emit({ type: 'feed.add', item });
    return item;
  }

  /** `from`: id di un agente o "user"; `to`: id di un agente, "user" o "all". */
  send(from: string, to: string, text: string): BusMessage {
    const msg: BusMessage = { id: this.ctx.store.nextId('m'), ts: this.ctx.now(), from, to, text, readBy: [] };
    this.ctx.store.pushMessage(msg);
    if (from === 'user') {
      this.feed('user', text, { to });
    } else {
      this.ctx.emit({ type: 'agent.say', agentId: from, to, text: truncate(text, 2000), ts: msg.ts });
      this.feed('message', text, { agentId: from, to });
    }
    for (const l of this.listeners) l(msg);
    return msg;
  }

  onMessage(listener: (m: BusMessage) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Messaggi non letti per `agentId`, dal più vecchio. */
  inbox(agentId: string, opts: { markRead?: boolean } = {}): BusMessage[] {
    const out = this.ctx.store.data.messages.filter((m) => m.from !== agentId && (m.to === agentId || m.to === 'all') && !m.readBy.includes(agentId));
    if (opts.markRead) this.markRead(agentId, out.map((m) => m.id));
    return out;
  }

  markRead(agentId: string, ids: string[]): void {
    if (!ids.length) return;
    const set = new Set(ids);
    let changed = false;
    for (const m of this.ctx.store.data.messages) {
      if (set.has(m.id) && !m.readBy.includes(agentId)) {
        m.readBy.push(agentId);
        changed = true;
      }
    }
    if (changed) this.ctx.store.markDirty();
  }
}

/** Formatta dei messaggi per il prompt di un agente. */
export function formatInbox(msgs: BusMessage[], nameOf: (id: string) => string, userName: string): string {
  return msgs.map((m) => `- da ${m.from === 'user' ? `${userName} (utente)` : nameOf(m.from)}${m.to === 'all' ? ' a tutti' : ''}: ${m.text}`).join('\n');
}
