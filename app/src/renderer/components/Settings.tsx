import type { ViewState } from '@keystone/shared';
import { useEffect, useState } from 'react';

interface Props {
  state: ViewState;
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<void>;
}

const SOURCE: Record<string, string> = {
  settings: 'impostato qui',
  cli: 'da --user-name',
  git: 'da git user.name',
  system: 'nome utente del sistema (git user.name non è impostato)',
};

/** Impostazioni: per ora il tuo nome, come lo usano gli agenti, i messaggi e il registro. */
export function Settings({ state, send }: Props) {
  const current = state.status?.userName ?? '';
  const source = state.status?.userNameSource;
  const [name, setName] = useState(current);
  useEffect(() => setName(current), [current]);
  return (
    <div className="view">
      <div className="view-header">
        <h1>Impostazioni</h1>
        <span className="sub">valgono per questo profilo e dai prossimi turni degli agenti</span>
      </div>
      <div className="card">
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Il tuo nome</h3>
        <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
          Come ti chiamano gli agenti nei messaggi, nelle domande e nelle richieste di merge. {source ? `Ora: ${SOURCE[source] ?? source}.` : ''}
        </div>
        <form
          className="row"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void send({ type: 'settings.set', userName: name.trim() || null });
          }}
        >
          <input className="input" style={{ maxWidth: 320 }} data-testid="user-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="es. Aurora" />
          <button className="btn primary" type="submit" disabled={!name.trim() || name.trim() === current}>
            Salva
          </button>
          {source === 'settings' && (
            <button className="btn" type="button" onClick={() => void send({ type: 'settings.set', userName: null })} title="Torna a git user.name">
              Usa il predefinito
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
