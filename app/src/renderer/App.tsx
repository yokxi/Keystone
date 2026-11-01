import { emptyViewState, type Decision, type Task, type ViewState } from '@keystone/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionInfo, UiEvent } from '../main/api.js';
import type { ValidatedCommand } from '../main/ipc-validate.js';
import { Agents } from './components/Agents.js';
import { Board } from './components/Board.js';
import { Avatar } from './components/common.js';
import { Decisions } from './components/Decisions.js';
import { Memory } from './components/Memory.js';
import { RegisterRepoDialog, Repos } from './components/Repos.js';
import { Review, type ReviewTarget } from './components/Review.js';
import { Settings } from './components/Settings.js';
import { completeAgent, HELP, parseConsole } from './lib/console.js';
import { goalLimitsText, money, spendLabel, time, tokens } from './lib/format.js';

type View = 'board' | 'agents' | 'decisions' | 'review' | 'memory' | 'repos' | 'settings';
type Theme = 'system' | 'light' | 'dark';
interface FeedLine {
  ts: number;
  text: string;
  cls?: 'f-err' | 'f-me';
}
interface Toast {
  id: number;
  level: string;
  text: string;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('keystone-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function App() {
  const [state, setState] = useState<ViewState>(emptyViewState());
  const [view, setView] = useState<View>('board');
  const [agentId, setAgentId] = useState<string>();
  const [review, setReview] = useState<ReviewTarget>();
  const [register, setRegister] = useState<{ path?: string } | undefined>();
  const [help, setHelp] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conn, setConn] = useState<ConnectionInfo>();
  /** profilo scelto per il pulsante "Avvia orchestratore" (vuoto: quello dell'app) */
  const [startProfile, setStartProfile] = useState('');
  const toastSeq = useRef(0);

  // tema: segue il sistema o la scelta dell'utente
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('keystone-theme', theme);
    } catch {
      /* preferenza solo locale */
    }
  }, [theme]);

  const addFeed = useCallback((text: string, cls?: FeedLine['cls']) => setFeed((f) => [...f.slice(-80), { ts: Date.now(), text, ...(cls ? { cls } : {}) }]), []);
  const toast = useCallback((level: string, text: string) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-3), { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    void window.keystone.getState().then(setState);
    void window.keystone.connection().then(setConn);
    const offState = window.keystone.onState(setState);
    const offEvent = window.keystone.onEvent((e: UiEvent) => {
      if (e.type === 'notify') {
        addFeed(e.text, e.level === 'info' ? undefined : 'f-err');
        if (e.level !== 'info') toast(e.level, e.text);
      }
    });
    return () => {
      offState();
      offEvent();
    };
  }, [addFeed, toast]);

  // i messaggi degli agenti a te finiscono nella console
  const lastFeedTs = useRef(0);
  useEffect(() => {
    const fresh = state.feed.filter((f) => f.ts > lastFeedTs.current && f.kind === 'message' && f.to === 'user');
    if (state.feed.length) lastFeedTs.current = Math.max(lastFeedTs.current, ...state.feed.map((f) => f.ts));
    for (const f of fresh) addFeed(`${state.agents.find((a) => a.id === f.agentId)?.name ?? f.agentId}: ${f.text}`);
  }, [state.feed, state.agents, addFeed]);

  const send = useCallback(
    async (cmd: ValidatedCommand): Promise<string | undefined> => {
      const ack = await window.keystone.send(cmd);
      if (!ack.ok) {
        addFeed(ack.error ?? 'errore', 'f-err');
        return ack.error ?? 'errore';
      }
      if (cmd.type === 'worktrees.prune') {
        const report = (ack.result?.report as string[] | undefined) ?? [];
        addFeed(report.length ? `Pulizia worktree: ${report.join(' · ')}` : 'Pulizia worktree: niente da fare');
      }
      return undefined;
    },
    [addFeed],
  );
  const sendVoid = useCallback(async (cmd: ValidatedCommand) => void (await send(cmd)), [send]);

  const answer = useCallback((d: Decision, option?: string, text?: string) => send({ type: 'decision.answer', decisionId: d.id, ...(option ? { option } : {}), ...(text ? { text } : {}) }), [send]);

  const openReviewTask = (t: Task) => {
    if (!t.repoId || !t.worktree) return;
    setReview({ repoId: t.repoId, worktree: t.worktree, taskId: t.id });
    setView('review');
  };
  const openMerge = (d: Decision) => {
    if (!d.repoId || !d.worktree) return;
    setReview({ repoId: d.repoId, worktree: d.worktree, decisionId: d.id, ...(d.taskId ? { taskId: d.taskId } : {}) });
    setView('review');
  };

  // modalità di verifica: il main cambia vista e tema per catturare le schermate
  useEffect(() => {
    if (!location.search.includes('smoke=1')) return;
    window.__keystoneSmoke = (v, t, repoPath) => {
      setTheme(t);
      setRegister(undefined);
      if (v === 'register') {
        setView('repos');
        setRegister({ path: repoPath ?? state.repos[0]?.path ?? '' });
        return;
      }
      if (v === 'review') {
        const d = state.decisions.find((x) => x.kind === 'merge' && x.status === 'open');
        if (d) openMerge(d);
        else setView('board');
        return;
      }
      if (v === 'agents') setAgentId(state.agents.find((a) => a.role === 'worker' && (state.logs[a.id]?.length ?? 0) > 3)?.id);
      setView(v as View);
    };
  });

  const openDecisions = state.decisions.filter((d) => d.status === 'open').length;
  const agentsRef = useMemo(() => state.agents.map((a) => ({ id: a.id, name: a.name })), [state.agents]);

  return (
    <div className="app">
      <StatusBar state={state} theme={theme} setTheme={setTheme} decisions={openDecisions} />
      <nav className="sidebar">
        <NavItem icon="▦" label="Tabellone" active={view === 'board'} onClick={() => setView('board')} />
        <NavItem icon="◉" label="Agenti" active={view === 'agents'} onClick={() => setView('agents')} />
        <NavItem icon="!" label="Decisioni" active={view === 'decisions'} onClick={() => setView('decisions')} count={openDecisions} />
        <NavItem icon="±" label="Review" active={view === 'review'} onClick={() => setView('review')} />
        <NavItem icon="❐" label="Memoria" active={view === 'memory'} onClick={() => setView('memory')} />
        <NavItem icon="⎇" label="Repository" active={view === 'repos'} onClick={() => setView('repos')} />
        <NavItem icon="⚙" label="Impostazioni" active={view === 'settings'} onClick={() => setView('settings')} />
        <div className="side-section">Team</div>
        {state.agents.map((a) => (
          <button
            key={a.id}
            className="side-agent"
            onClick={() => {
              setAgentId(a.id);
              setView('agents');
            }}
            title={`${a.name}: ${a.model}`}
          >
            <Avatar agent={a} agents={state.agents} size={20} />
            <span className="ellipsis">{a.name}</span>
            <span className="meta ellipsis">{a.model}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {!state.connected && (
          <div className={`banner ${conn ? '' : 'bad'}`}>
            <span className="grow">Orchestratore non raggiungibile su {conn?.url ?? '…'}: riprovo da solo. Puoi avviarlo con "npm run orchestrator".</span>
            {conn?.canStart && (
              <>
                {conn.profiles.some((p) => p !== conn.profile) && (
                  <select className="input small" style={{ width: "auto" }} aria-label="Profilo da avviare" data-testid="start-profile" value={startProfile || conn.profile} onChange={(e) => setStartProfile(e.target.value)}>
                    {[conn.profile, ...conn.profiles.filter((p) => p !== conn.profile)].map((p) => (
                      <option key={p} value={p}>
                        {p === conn.profile ? `${p} (profilo dell'app)` : p}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="btn small"
                  data-testid="start-orchestrator"
                  title="Avvia l'orchestratore con il motore sim su questa porta. Per il motore Claude usa npm run orchestrator -- --engine claude."
                  onClick={() => void window.keystone.startOrchestrator(startProfile || conn.profile).then((a) => !a.ok && toast('warn', a.error ?? 'avvio non riuscito'))}
                >
                  Avvia orchestratore · profilo {startProfile || conn.profile}
                </button>
              </>
            )}
          </div>
        )}
        {state.connected && conn && state.status?.profile && state.status.profile !== conn.profile && (
          <div className="banner bad" data-testid="profile-mismatch">
            L'app usa il profilo "{conn.profile}" ma l'orchestratore collegato su {conn.url} usa "{state.status.profile}". Riavvia l'app con KEYSTONE_PROFILE={state.status.profile} oppure avvia l'orchestratore del profilo "{conn.profile}".
          </div>
        )}
        {state.status?.auth === 'failed' && <div className="banner bad">Autenticazione dei motori non riuscita: {state.status.message}</div>}
        {view === 'board' && <Board state={state} send={sendVoid} openReview={openReviewTask} />}
        {view === 'agents' && <Agents state={state} selected={agentId} select={setAgentId} send={sendVoid} />}
        {view === 'decisions' && <Decisions state={state} answer={answer} openMerge={openMerge} />}
        {view === 'review' && <Review state={state} target={review} answer={answer} close={() => setView('decisions')} />}
        {view === 'memory' && <Memory state={state} />}
        {view === 'repos' && <Repos state={state} send={sendVoid} openRegister={(p) => setRegister({ ...(p ? { path: p } : {}) })} />}
        {view === 'settings' && <Settings state={state} send={sendVoid} />}
      </main>
      <ConsoleBar
        agents={agentsRef}
        feed={feed}
        onSubmit={async (text) => {
          const r = parseConsole(text, agentsRef);
          if (r.kind === 'none') return true;
          if (r.kind === 'error') {
            addFeed(r.message, 'f-err');
            return false;
          }
          if (r.kind === 'ui') {
            if (r.action === 'help') setHelp(true);
            else setRegister({ ...(r.arg ? { path: r.arg } : {}) });
            return true;
          }
          // un merge parte solo dal pulsante nella schermata di review, dopo aver visto il diff
          if (r.cmd.type === 'decision.answer') {
            const cmd = r.cmd;
            const target = state.decisions.find((d) => d.id === cmd.decisionId);
            if (target?.kind === 'merge') {
              addFeed(`${target.id} è una decisione di merge: rispondi dalla schermata di review, dopo aver visto il diff.`, 'f-err');
              openMerge(target);
              return false;
            }
          }
          addFeed(r.echo, 'f-me');
          const err = await send(r.cmd);
          return !err;
        }}
      />
      {register && <RegisterRepoDialog {...(register.path ? { initialPath: register.path } : {})} close={() => setRegister(undefined)} send={send} />}
      {help && <HelpDialog close={() => setHelp(false)} />}
      <div className="toast-area">
        {toasts.map((t) => (
          <div key={t.id} className={`card toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function NavItem({ icon, label, active, onClick, count }: { icon: string; label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      {label}
      {!!count && <span className="count">{count}</span>}
    </button>
  );
}

function StatusBar({ state, theme, setTheme, decisions }: { state: ViewState; theme: Theme; setTheme: (t: Theme) => void; decisions: number }) {
  const s = state.status;
  const dot = !state.connected ? 'bad' : s?.auth === 'failed' ? 'bad' : s?.auth === 'ok' ? 'ok' : 'warn';
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  return (
    <header className="statusbar">
      <div className="brand">
        <span className="brand-mark">K</span>Keystone
      </div>
      <span className="status-msg ellipsis">
        <span className={`dot ${dot}`} />
        {state.connected ? (s?.message ?? 'connesso') : 'non connesso'}
      </span>
      <div className="status-items">
        {decisions > 0 && <span className="badge bad">{decisions} {decisions === 1 ? 'decisione' : 'decisioni'}</span>}
        <GoalSpend state={state} />
        <span title={spendLabel(s?.billing).title} data-testid="total-spend">
          {spendLabel(s?.billing).word} <b style={{ color: 'var(--text)' }}>{money(s?.costUsd ?? 0)}</b>
          {spendLabel(s?.billing).suffix}
        </span>
        <span>
          token <b style={{ color: 'var(--text)' }}>{tokens(s?.tokens ?? 0)}</b>
        </span>
        <span className="sep" />
        {s?.userName && <span>{s.userName}</span>}
        <button className="btn small ghost" onClick={() => setTheme(next[theme])} title="Tema: sistema → chiaro → scuro">
          {theme === 'system' ? '◐ sistema' : theme === 'light' ? '☀ chiaro' : '☾ scuro'}
        </button>
      </div>
    </header>
  );
}

/** Spesa dell'obiettivo corrente rispetto al suo tetto. */
function GoalSpend({ state }: { state: ViewState }) {
  const goal = [...state.goals].reverse().find((g) => g.status === 'planning' || g.status === 'active' || g.status === 'paused') ?? state.goals[state.goals.length - 1];
  if (!goal) return null;
  const ratio = goal.budgetUsd ? goal.costUsd / goal.budgetUsd : 0;
  const label = spendLabel(state.status?.billing);
  const estimate = state.status?.billing === 'subscription';
  const cls = goal.status === 'paused' || ratio >= 1 ? 'bad' : ratio >= 0.8 ? 'warn' : '';
  return (
    <span
      className={`badge ${cls}`}
      title={`${estimate ? `${label.title}. ` : ''}Spesa dell'obiettivo ${goal.id}${goal.budgetUsd ? (estimate ? ' rispetto al tetto sulla stima' : ' rispetto al tetto') : ' (nessun tetto)'}${goal.costUnreconciledUsd ? `. Di questa, ${money(goal.costUnreconciledUsd)} è contata per prudenza: una sessione ripresa potrebbe non aver ritrovato la spesa precedente, che quindi potrebbe essere contata due volte.` : ''}`}
      data-testid="goal-spend"
    >
      obiettivo {estimate ? `${label.word} ` : ''}
      {money(goal.costUsd)}
      {goal.budgetUsd ? ` / ${money(goal.budgetUsd)}` : ' · senza tetto'}
      {label.suffix}
      {goal.costUnreconciledUsd ? ` (≤ ${money(goal.costUnreconciledUsd)} prudenziali)` : ''}
      {goalLimitsText(goal)}
      {goal.status === 'paused' ? ' · in pausa' : ''}
    </span>
  );
}

function ConsoleBar({ agents, feed, onSubmit }: { agents: Array<{ id: string; name: string }>; feed: FeedLine[]; onSubmit: (text: string) => Promise<boolean> }) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed]);
  const caret = input.current?.selectionStart ?? value.length;
  const suggestion = completeAgent(value, caret, agents);
  return (
    <div className="console">
      {feed.length > 0 && (
        <div className="console-feed" ref={feedRef}>
          {feed.map((f, i) => (
            <div key={i} className={f.cls}>
              <span className="f-time">{time(f.ts)}</span>
              {f.text}
            </div>
          ))}
        </div>
      )}
      <div className="console-input-row">
        {suggestion && suggestion.options.length > 0 && (
          <div className="suggest">
            {suggestion.options.slice(0, 6).map((o) => (
              <span key={o}>@{o}</span>
            ))}
          </div>
        )}
        <span className="console-prompt">›</span>
        <input
          ref={input}
          className="console-input"
          placeholder="Scrivi un obiettivo, @agente messaggio, oppure /aiuto"
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setHIdx(-1);
          }}
          onKeyDown={async (e) => {
            if (e.key === 'Tab' && suggestion) {
              e.preventDefault();
              setValue(suggestion.value);
              requestAnimationFrame(() => input.current?.setSelectionRange(suggestion.caret, suggestion.caret));
            } else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
              setHIdx(i);
              setValue(history[i]!);
            } else if (e.key === 'ArrowDown' && hIdx >= 0) {
              e.preventDefault();
              const i = hIdx + 1;
              if (i >= history.length) {
                setHIdx(-1);
                setValue('');
              } else {
                setHIdx(i);
                setValue(history[i]!);
              }
            } else if (e.key === 'Enter') {
              const text = value;
              if (!text.trim()) return;
              setHistory((h) => [...h.filter((x) => x !== text), text].slice(-50));
              if (await onSubmit(text)) setValue('');
            }
          }}
        />
        <span className="console-hint">Tab completa @agente · ↑ cronologia</span>
      </div>
    </div>
  );
}

function HelpDialog({ close }: { close: () => void }) {
  return (
    <div className="overlay" onClick={close}>
      <div className="card dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Comandi della console</h2>
        <table className="help-table">
          <tbody>
            {HELP.map(([c, d]) => (
              <tr key={c}>
                <td>{c}</td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dialog-actions">
          <button className="btn primary" onClick={close}>
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
