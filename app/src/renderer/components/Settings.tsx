import type { ViewState } from '@keystone/shared';
import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../main/api.js';

interface Props {
  state: ViewState;
  send: (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<void>;
  update: UpdateStatus | undefined;
  toast: (level: string, text: string) => void;
}

/** stati in cui un agente sta lavorando a un turno */
const WORKING = new Set(['thinking', 'reading', 'editing', 'running', 'testing']);

function when(ts: number | undefined): string {
  return ts ? new Date(ts).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

/** Cosa dire del controllo: disponibile, già aggiornata, errore, mai controllato. */
export function updateLine(u: UpdateStatus | undefined): string {
  if (!u) return '';
  if (u.checking) return 'Controllo in corso…';
  const r = u.result;
  if (!r) return u.forcedOff ? 'Controllo spento da KEYSTONE_NO_UPDATE_CHECK.' : 'Nessun controllo ancora.';
  if (r.status === 'available') return `È disponibile Keystone ${r.info.version}.`;
  if (r.status === 'none') return `Hai l'ultima versione (${r.latest}). Controllato il ${when(u.lastCheck)}.`;
  return `Controllo non riuscito: ${r.error}.${u.lastCheck ? ` (${when(u.lastCheck)})` : ''}`;
}

const SOURCE: Record<string, string> = {
  settings: 'impostato qui',
  cli: 'da --user-name',
  git: 'da git user.name',
  system: 'nome utente del sistema (git user.name non è impostato)',
};

/** Impostazioni: il tuo nome, gli aggiornamenti e l'arresto dell'orchestratore. */
export function Settings({ state, send, update, toast }: Props) {
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
          <input className="input" style={{ maxWidth: 320 }} data-testid="user-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="es. Maria" />
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
      <UpdatesCard update={update} />
      <div className="card">
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Orchestratore</h3>
        <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
          L'orchestratore continua a lavorare anche a finestra chiusa. Fermalo prima di aggiornare o disinstallare Keystone: salva lo stato ed esce. Lo riavvii con "Avvia orchestratore".
        </div>
        <button
          className="btn"
          data-testid="stop-orchestrator"
          disabled={!state.connected}
          onClick={() => {
            const busy = state.agents.filter((a) => WORKING.has(a.state)).map((a) => a.name);
            const msg = busy.length ? `Stanno lavorando: ${busy.join(', ')}. I turni in corso si interrompono e riprendono al prossimo avvio. Fermare l'orchestratore?` : "Fermare l'orchestratore?";
            if (!confirm(msg)) return;
            void window.keystone.stopOrchestrator().then((a) => toast(a.ok ? 'info' : 'warn', a.ok ? "Orchestratore fermato: lo stato è salvato." : (a.error ?? 'arresto non riuscito')));
          }}
        >
          Ferma orchestratore
        </button>
      </div>
    </div>
  );
}

function UpdatesCard({ update }: { update: UpdateStatus | undefined }) {
  const available = update?.result?.status === 'available' ? update.result.info : undefined;
  return (
    <div className="card" data-testid="updates">
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>Aggiornamenti</h3>
      <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>
        Versione in uso: <b>{update?.current ?? '…'}</b>. Keystone controlla su GitHub se c'è una versione nuova e te lo dice: non scarica e non installa nulla da solo. Il controllo contatta solo api.github.com.
      </div>
      <label className="row" style={{ gap: 8, marginBottom: 8 }}>
        <input type="checkbox" data-testid="update-check" checked={!!update?.enabled} disabled={!update || update.forcedOff} onChange={(e) => void window.keystone.setUpdateCheck(e.target.checked)} />
        <span>Controlla gli aggiornamenti all'avvio e una volta al giorno</span>
      </label>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn" data-testid="update-now" disabled={!update || update.checking || update.forcedOff} onClick={() => void window.keystone.checkUpdates()}>
          Controlla ora
        </button>
        <span className="faint" style={{ fontSize: 13 }} data-testid="update-line">
          {updateLine(update)}
        </span>
      </div>
      {available && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{available.name}</div>
          {available.notes && (
            <pre className="faint" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 240, overflow: 'auto', margin: '0 0 8px' }}>
              {available.notes}
            </pre>
          )}
          <button className="btn primary" data-testid="open-release" onClick={() => void window.keystone.openRelease()}>
            Apri la pagina della release
          </button>
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            Scarica Keystone-Setup-{available.version}.exe, ferma l'orchestratore qui sopra e avvia l'installatore: aggiorna l'app e lascia com'è tutto il resto.
          </div>
        </div>
      )}
    </div>
  );
}
