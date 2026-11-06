# Keystone
Orchestratore desktop di un team di agenti AI (un lead e fino a cinque worker) che lavora su un tuo
repository git. Ogni task ha il suo worktree e il suo branch. Il tuo checkout cambia solo con un
merge che approvi tu.

## Motori

| Motore | Stato | Documentazione |
|---|---|---|
| Sim | simulato, senza API: per provare il flusso | — |
| Claude | Claude Agent SDK, chiave API o login personale | `docs/motore-claude.md` |
| Codex | **non incluso in questa versione** (il codice c'è; arriva dopo la prova con un modello reale) | `docs/motore-codex.md` |

Il motore Codex è stato verificato sulla CLI vera con un modello locale finto, ma non ancora con un
modello vero. L'etichetta resta finché la prova reale non è stata fatta: vedi `docs/piano.md`, "Da
fare prima della pubblicazione".

## Avvio

```powershell
npm install
npm run orchestrator -- --demo        # team simulato su un repository di prova
npm run app                           # l'interfaccia (in un altro terminale)
```

Per l'app portabile (senza sorgenti né Node): `npm run package -w app` (vedi `docs/pacchetto.md`).

Con un motore vero: `--engine claude` (Codex non è incluso in questa versione; per prove di
sviluppo: `KEYSTONE_ENABLE_CODEX=1`). Per un team misto: `--lead-engine` e
`--worker-engine`. Tutte le opzioni: `npm run orchestrator -- --help`. Le stesse impostazioni si
possono scrivere in `~/.keystone/config.json` (vedi `docs/configurazione.md`).

## Documenti

- `docs/sicurezza.md`: cosa può e non può fare un agente, e i limiti ("non è una sandbox").
- `docs/interfaccia.md`: le pagine dell'app.
- `docs/protocol.md`: il protocollo tra orchestratore e app.
- `docs/verifica-visuale.md`: le schermate prima/dopo nella review, eseguite da Keystone.
- `docs/skill.md`: le regole in markdown per gli agenti (del repository e personali).
- `docs/configurazione.md`: il file `~/.keystone/config.json`.
- `docs/pacchetto.md`: l'app portabile e come avvia l'orchestratore.
- `docs/database.md`: l'accesso degli agenti ai database, in sola lettura.
- `docs/piano.md`: le fasi successive.
