import { SkillDraft, skillIdFromName, SKILL_LIMITS, type Skill, type SkillAudience, type SkillPhase, type ViewState } from '@keystone/shared';
import { useState } from 'react';
import { Markdown } from '../lib/markdown.js';

type Send = (cmd: Parameters<Window['keystone']['send']>[0]) => Promise<string | undefined>;

export const AUDIENCE_LABEL: Record<SkillAudience, string> = { lead: 'lead', worker: 'worker', tutti: 'tutti gli agenti' };
export const PHASE_LABEL: Record<SkillPhase, string> = { sempre: 'sempre', piano: 'piano (lead)', lavoro: 'lavoro (worker)', review: 'review (lead)' };
const PHASES: SkillPhase[] = ['sempre', 'piano', 'lavoro', 'review'];

/** Dove salvare una skill: "personal" oppure l'id di un repository. */
export type SkillPlace = 'personal' | `repo:${string}`;

export const skillKey = (s: Pick<Skill, 'source' | 'repoId' | 'id'>) => `${s.source}:${s.repoId ?? ''}:${s.id}`;

/** Il comando che salva una skill nel posto scelto. */
export function saveCommand(place: SkillPlace, id: string, draft: SkillDraft, create: boolean): Parameters<Window['keystone']['send']>[0] {
  return place === 'personal' ? { type: 'skill.save', source: 'personal', skillId: id, create, draft } : { type: 'skill.save', source: 'repo', repoId: place.slice(5), skillId: id, create, draft };
}

/** Un id libero nel posto scelto, dal nome della skill. */
export function freeSkillId(state: ViewState, place: SkillPlace, name: string): string {
  const taken = new Set(state.skills.filter((s) => (place === 'personal' ? s.source === 'personal' : s.source === 'repo' && s.repoId === place.slice(5))).map((s) => s.id));
  return skillIdFromName(name, taken);
}

/** Note sul posto: le skill del repository valgono solo dopo il commit sul branch di destinazione. */
export function PlaceNote({ state, place }: { state: ViewState; place: SkillPlace }) {
  if (place === 'personal') return <p className="note">Personale: solo per te, in ~/.keystone/skills. Vale da subito per tutti i tuoi repository.</p>;
  const repo = state.repos.find((r) => `repo:${r.id}` === place);
  return (
    <p className="note">
      Del repository: il file va nel tuo checkout ({repo?.name ?? '?'}/.keystone/skills) e si condivide con git. Gli agenti la ricevono solo dopo che l'hai committata sul branch di
      destinazione ({repo?.mergeTarget ?? repo?.branch ?? '?'}): Keystone legge le skill da lì, mai dai worktree degli agenti.
    </p>
  );
}

export function PlaceSelect({ state, value, onChange, id }: { state: ViewState; value: SkillPlace; onChange: (p: SkillPlace) => void; id?: string }) {
  return (
    <select id={id} className="input small" value={value} onChange={(e) => onChange(e.target.value as SkillPlace)} data-testid="skill-place">
      <option value="personal">Personale (solo per te)</option>
      {state.repos.map((r) => (
        <option key={r.id} value={`repo:${r.id}`}>
          Repository {r.name} (condivisa con git)
        </option>
      ))}
    </select>
  );
}

/** Modulo di una skill: restituisce il contenuto validato con lo schema del protocollo. */
export function SkillForm({ initial, busy, error, submitLabel, onSubmit, onCancel, children }: { initial: SkillDraft; busy: boolean; error?: string | undefined; submitLabel: string; onSubmit: (d: SkillDraft) => void; onCancel: () => void; children?: React.ReactNode }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [appliesTo, setAppliesTo] = useState<SkillAudience>(initial.appliesTo);
  const [when, setWhen] = useState<SkillPhase[]>(initial.when);
  const [files, setFiles] = useState(initial.files.join(', '));
  const [enabled, setEnabled] = useState(initial.enabled);
  const [body, setBody] = useState(initial.body);
  const draft = { name, ...(description.trim() ? { description } : {}), appliesTo, when, files: files.split(',').map((f) => f.trim()).filter(Boolean), enabled, body };
  const parsed = SkillDraft.safeParse(draft);
  const invalid = parsed.success ? undefined : `${String(parsed.error.issues[0]?.path[0] ?? '')}: ${parsed.error.issues[0]?.message ?? ''}`;
  const togglePhase = (p: SkillPhase, on: boolean) => {
    if (p === 'sempre') return setWhen(on ? ['sempre'] : ['lavoro']);
    const next = on ? [...when.filter((x) => x !== 'sempre'), p] : when.filter((x) => x !== p);
    setWhen(next.length ? next : ['sempre']);
  };
  return (
    <div className="skill-form" data-testid="skill-form">
      <div className="grid">
        {children}
        <label htmlFor="sk-name">Nome</label>
        <input id="sk-name" className="input small" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Messaggi di commit" />
        <label htmlFor="sk-desc">Descrizione</label>
        <input id="sk-desc" className="input small" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="facoltativa, una riga" />
        <label htmlFor="sk-for">Per</label>
        <select id="sk-for" className="input small" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as SkillAudience)}>
          {(['tutti', 'lead', 'worker'] as const).map((a) => (
            <option key={a} value={a}>
              {AUDIENCE_LABEL[a]}
            </option>
          ))}
        </select>
        <span>Quando</span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          {PHASES.map((p) => (
            <label key={p} className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={when.includes(p)} onChange={(e) => togglePhase(p, e.target.checked)} />
              {PHASE_LABEL[p]}
            </label>
          ))}
        </div>
        <label htmlFor="sk-files">Solo per i file</label>
        <input id="sk-files" className="input mono small" value={files} onChange={(e) => setFiles(e.target.value)} placeholder="facoltativo, es. src/api/**, *.sql" />
        <span />
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Attiva
        </label>
        <label htmlFor="sk-body">Regola</label>
        <textarea id="sk-body" className="input" rows={8} value={body} maxLength={SKILL_LIMITS.bodyChars} onChange={(e) => setBody(e.target.value)} placeholder="Cosa devono fare (o non fare) gli agenti, in markdown." />
      </div>
      {(error ?? invalid) && <div className="decision-error">{error ?? invalid}</div>}
      <div className="decision-actions" style={{ marginTop: 8 }}>
        <button className="btn primary small" disabled={busy || !parsed.success} onClick={() => parsed.success && onSubmit(parsed.data)}>
          {submitLabel}
        </button>
        <button className="btn small" disabled={busy} onClick={onCancel}>
          Annulla
        </button>
      </div>
    </div>
  );
}

const EMPTY: SkillDraft = { name: '', appliesTo: 'tutti', when: ['sempre'], files: [], enabled: true, body: '' };

function StatusBadges({ s }: { s: Skill }) {
  const d = s.draft ?? s.local;
  return (
    <>
      {s.error && <span className="badge bad">non valida</span>}
      {s.unconfirmed && (
        <span className="badge warn" title="Creata o cambiata fuori dall'app: gli agenti non la ricevono finché non la confermi">
          da confermare
        </span>
      )}
      {!s.error && !s.effective && !s.unconfirmed && s.pending !== 'new' && <span className="badge">disattivata</span>}
      {s.effective && <span className="badge ok">attiva</span>}
      {s.override !== undefined && <span className="badge" title="Attivazione solo tua, non scritta nel file">solo per te</span>}
      {s.pending === 'new' && <span className="badge warn">da committare</span>}
      {s.pending === 'modified' && <span className="badge warn">modifiche da committare</span>}
      {s.pending === 'deleted' && <span className="badge warn">cancellazione da committare</span>}
      {d && <span className="badge">{AUDIENCE_LABEL[d.appliesTo]}</span>}
    </>
  );
}

export function Skills({ state, send }: { state: ViewState; send: Send }) {
  const [selected, setSelected] = useState<string>();
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view');
  const [place, setPlace] = useState<SkillPlace>('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const skill = state.skills.find((s) => skillKey(s) === selected) ?? (mode === 'new' ? undefined : state.skills[0]);
  const repoName = (id?: string) => state.repos.find((r) => r.id === id)?.name ?? id ?? '?';
  const groups: Array<{ title: string; items: Skill[]; warning?: string }> = [
    ...state.repos.map((r) => ({
      title: `Repository ${r.name}`,
      items: state.skills.filter((s) => s.source === 'repo' && s.repoId === r.id),
      ...(!r.mergeTarget && r.branch === 'HEAD' ? { warning: "Il checkout non è su un branch (HEAD staccato) e non c'è un branch di destinazione: gli agenti non ricevono le skill di questo repository." } : {}),
    })),
    { title: 'Personali', items: state.skills.filter((s) => s.source === 'personal') },
  ];

  const run = async (cmd: Parameters<Send>[0], done?: string) => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    const err = await send(cmd);
    setBusy(false);
    if (err) setError(err);
    else if (done) setInfo(done);
    return !err;
  };

  const where = (s: Skill) => (s.source === 'repo' ? { source: 'repo' as const, repoId: s.repoId!, skillId: s.id } : { source: 'personal' as const, skillId: s.id });

  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="view-header">
        <h1>Skill</h1>
        <span className="sub">regole per gli agenti: del repository (condivise con git) e personali</span>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void run({ type: 'skills.refresh' })} title="Rilegge le skill, per esempio dopo un commit">
            Rileggi
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setMode('new');
              setSelected(undefined);
              setError(undefined);
              setInfo(undefined);
            }}
          >
            Nuova skill
          </button>
        </div>
      </div>
      {info && <div className="card skill-info">{info}</div>}
      <div className="memory grow">
        <div className="memory-list" data-testid="skill-list">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="side-section" style={{ margin: '8px 4px 4px' }}>
                {g.title}
              </div>
              {g.warning && <div className="decision-error" style={{ fontSize: 12.5, padding: '2px 10px' }}>{g.warning}</div>}
              {g.items.length === 0 && <div className="faint" style={{ fontSize: 12.5, padding: '2px 10px' }}>nessuna</div>}
              {g.items.map((s) => (
                <button
                  key={skillKey(s)}
                  className={`memory-item ${mode !== 'new' && skill && skillKey(skill) === skillKey(s) ? 'active' : ''}`}
                  data-testid={`skill-${skillKey(s)}`}
                  onClick={() => {
                    setSelected(skillKey(s));
                    setMode('view');
                    setError(undefined);
                  }}
                >
                  <div className="row">
                    <b className="grow ellipsis">{s.draft?.name ?? s.local?.name ?? s.id}</b>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                    <StatusBadges s={s} />
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="card memory-doc">
          {mode === 'new' && (
            <>
              <h2>Nuova skill</h2>
              <SkillForm
                initial={EMPTY}
                busy={busy}
                error={error}
                submitLabel="Crea"
                onCancel={() => setMode('view')}
                onSubmit={(d) => {
                  const id = freeSkillId(state, place, d.name);
                  void run(saveCommand(place, id, d, true), place === 'personal' ? `Skill "${d.name}" creata: vale da subito.` : `Skill "${d.name}" scritta nel checkout: committala sul branch di destinazione perché gli agenti la ricevano.`).then((ok) => {
                    if (ok) {
                      setSelected(`${place === 'personal' ? 'personal' : 'repo'}:${place === 'personal' ? '' : place.slice(5)}:${id}`);
                      setMode('view');
                    }
                  });
                }}
              >
                <label htmlFor="sk-place">Dove</label>
                <PlaceSelect id="sk-place" state={state} value={place} onChange={setPlace} />
              </SkillForm>
              <PlaceNote state={state} place={place} />
            </>
          )}
          {mode !== 'new' && !skill && <div className="empty">Nessuna skill. Creane una, oppure salva come skill una correzione dalla review.</div>}
          {mode === 'edit' && skill && (
            <>
              <h2>Modifica {skill.draft?.name ?? skill.local?.name ?? skill.id}</h2>
              <SkillForm
                initial={skill.local ?? skill.draft ?? EMPTY}
                busy={busy}
                error={error}
                submitLabel="Salva"
                onCancel={() => setMode('view')}
                onSubmit={(d) => {
                  void run(
                    { type: 'skill.save', ...where(skill), create: false, draft: d },
                    skill.source === 'personal' ? 'Skill salvata: vale da subito.' : 'Skill salvata nel checkout: committala sul branch di destinazione perché gli agenti ricevano la nuova versione.',
                  ).then((ok) => ok && setMode('view'));
                }}
              />
              <PlaceNote state={state} place={skill.source === 'personal' ? 'personal' : `repo:${skill.repoId!}`} />
            </>
          )}
          {mode === 'view' && skill && (
            <div data-testid="skill-detail">
              <div className="faint mono" style={{ fontSize: 12 }}>
                {skill.source === 'repo' ? `${repoName(skill.repoId)}/.keystone/skills/${skill.id}.md` : `~/.keystone/skills/${skill.id}.md`}
              </div>
              <h2>{skill.draft?.name ?? skill.local?.name ?? skill.id}</h2>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                <StatusBadges s={skill} />
              </div>
              {skill.source === 'repo' && (
                <p className="note">
                  {skill.pending === 'new'
                    ? `È solo nel tuo checkout: gli agenti non la ricevono finché non la committi su ${skill.branch ?? 'il branch di destinazione'}.`
                    : skill.pending === 'modified'
                      ? `Nel tuo checkout c'è una versione diversa, da committare: gli agenti ricevono ancora quella su ${skill.branch ?? '?'}.`
                      : skill.pending === 'deleted'
                        ? `L'hai cancellata dal checkout: gli agenti la ricevono finché la cancellazione non è committata su ${skill.branch ?? '?'}.`
                        : `Letta dal branch ${skill.branch ?? '?'}: è la versione che ricevono gli agenti.`}
                  {(skill.pending === 'modified' || skill.pending === 'deleted') &&
                    ' Finché non committi, i merge in questo repository si fermano: il checkout ha modifiche non committate.'}
                </p>
              )}
              {skill.unconfirmed && (
                <p className="note" data-testid="skill-unconfirmed">
                  Questo file è stato creato o cambiato fuori dall'app (a mano, da un programma o da uno script). Gli agenti non lo
                  ricevono finché non lo confermi: leggi il testo qui sotto e conferma solo se l'hai scritto tu.
                </p>
              )}
              {(skill.error || skill.localError) && <div className="decision-error">{skill.error ?? skill.localError}</div>}
              {(skill.draft ?? skill.local) && <SkillSummary d={(skill.draft ?? skill.local)!} />}
              <div className="decision-actions" style={{ margin: '12px 0' }}>
                {skill.unconfirmed && skill.draft && (
                  <button
                    className="btn small primary"
                    disabled={busy}
                    data-testid="skill-confirm"
                    onClick={() => void run({ type: 'skill.confirm', skillId: skill.id, hash: skill.unconfirmed! })}
                  >
                    Conferma
                  </button>
                )}
                <button className="btn small" disabled={busy} onClick={() => setMode('edit')}>
                  Modifica
                </button>
                {skill.draft && (
                  <button
                    className="btn small"
                    disabled={busy}
                    data-testid="skill-toggle"
                    onClick={() => void run({ type: 'skill.toggle', ...where(skill), enabled: !skill.effective })}
                    title="Solo per te: il file non cambia"
                  >
                    {skill.effective ? 'Disattiva per me' : 'Attiva per me'}
                  </button>
                )}
                {skill.override !== undefined && (
                  <button className="btn small ghost" disabled={busy} onClick={() => void run({ type: 'skill.toggle', ...where(skill), enabled: null })}>
                    Usa "attiva" del file
                  </button>
                )}
                {skill.pending !== 'deleted' && (
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Cancellare il file della skill "${skill.id}"?${skill.source === 'repo' ? ' (nel tuo checkout: la cancellazione va committata)' : ''}`)) return;
                      void run({ type: 'skill.delete', ...where(skill) });
                    }}
                  >
                    Cancella
                  </button>
                )}
              </div>
              {error && <div className="decision-error">{error}</div>}
              {(skill.local ?? skill.draft) && (
                <div className="skill-body">
                  <Markdown text={(skill.local ?? skill.draft)!.body} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillSummary({ d }: { d: SkillDraft }) {
  return (
    <dl className="report">
      {d.description && (
        <>
          <dt>Descrizione</dt>
          <dd>{d.description}</dd>
        </>
      )}
      <dt>Per</dt>
      <dd>{AUDIENCE_LABEL[d.appliesTo]}</dd>
      <dt>Quando</dt>
      <dd>{d.when.map((w) => PHASE_LABEL[w]).join(', ')}</dd>
      {d.files.length > 0 && (
        <>
          <dt>Solo per i file</dt>
          <dd className="mono">{d.files.join(', ')}</dd>
        </>
      )}
      <dt>Nel file</dt>
      <dd>{d.enabled ? 'attiva' : 'disattivata'}</dd>
    </dl>
  );
}
