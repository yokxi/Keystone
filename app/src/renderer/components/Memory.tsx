import type { ViewState } from '@keystone/shared';
import { useState } from 'react';
import { ago } from '../lib/format.js';
import { Markdown } from '../lib/markdown.js';

export function Memory({ state }: { state: ViewState }) {
  const [selected, setSelected] = useState<string>();
  const notes = [...state.memory].sort((a, b) => (a.scope === 'shared' ? 0 : 1) - (b.scope === 'shared' ? 0 : 1) || b.updated - a.updated);
  const note = notes.find((n) => n.id === selected) ?? notes[0];
  const nameOf = (id?: string) => state.agents.find((a) => a.id === id)?.name ?? id ?? '';
  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="view-header">
        <h1>Memoria condivisa</h1>
        <span className="sub">piano, decisioni e convenzioni che gli agenti leggono (file markdown in ~/.keystone, modificabili a mano)</span>
      </div>
      {notes.length === 0 ? (
        <div className="card empty">Ancora nessuna nota. Il lead scrive qui il piano di ogni obiettivo.</div>
      ) : (
        <div className="memory grow">
          <div className="memory-list">
            {notes.map((n) => (
              <button key={n.id} className={`memory-item ${note?.id === n.id ? 'active' : ''}`} onClick={() => setSelected(n.id)}>
                <div className="row">
                  <b className="grow ellipsis">{n.title}</b>
                  <span className={`badge ${n.scope === 'shared' ? 'accent' : ''}`}>{n.scope === 'shared' ? 'team' : nameOf(n.scope)}</span>
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {n.author ? `${nameOf(n.author)} · ` : ''}
                  {ago(n.updated)}
                </div>
              </button>
            ))}
          </div>
          {note && (
            <div className="card memory-doc">
              <div className="faint mono" style={{ fontSize: 12 }}>
                {note.id}
              </div>
              <h2>{note.title}</h2>
              <Markdown text={note.body} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
