// Parser di comandi di shell per la policy dei permessi. Non esegue nulla: scompone il testo in
// comandi semplici (parole, assegnazioni, redirezioni) e segnala tutto ciò che rende un comando
// non verificabile staticamente (sostituzioni, variabili, here-doc, sintassi non riconosciuta).
//
// Copre la sintassi comune a bash/sh, e in modo approssimato cmd e PowerShell: virgolette singole
// e doppie, escape, ; && || | & a capo, ( ) di raggruppamento, redirezioni (> >> < 2> &> 2>&1 <<
// <<<), $(...), `...`, <(...), >(...), $VAR ${VAR} %VAR% ~ e le espansioni { , }.
// In caso di dubbio il risultato è marcato come non verificabile: la policy allora chiede.

export interface Word {
  /** testo dopo la rimozione delle virgolette */
  text: string;
  /** contiene $VAR, ${...}, %VAR%, ~ iniziale, {a,b} o una sostituzione: il valore non è noto */
  dynamic: boolean;
  /** contiene caratteri glob (* ? [) fuori dalle virgolette */
  glob: boolean;
}

export interface Redirect {
  op: string;
  /** destinazione (undefined per duplicazioni come 2>&1) */
  target?: Word;
}

export interface SimpleCommand {
  /** assegnazioni iniziali: X=1 cmd */
  assignments: string[];
  words: Word[];
  redirects: Redirect[];
  /** riceve uno script su stdin (here-doc / here-string) */
  stdinScript: boolean;
}

export interface Parsed {
  commands: SimpleCommand[];
  /** testo interno di $(...), `...`, <(...), >(...): da classificare come comandi a sé */
  substitutions: string[];
  /** motivo per cui il testo non è stato capito del tutto (la policy chiede) */
  error?: string;
}

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n', '(', ')'];

/** Legge il contenuto di una sostituzione a partire da `i` (dopo l'apertura). Restituisce [testo, indice dopo la chiusura]. */
function readBalanced(s: string, i: number, open: string, close: string): [string, number] | undefined {
  let depth = 1;
  let j = i;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", j + 1);
      if (end < 0) return undefined;
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      j++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return [s.slice(i, j), j + 1];
    j++;
  }
  return undefined;
}

export function parseShell(input: string): Parsed {
  const s = input.replace(/\r\n/g, '\n');
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  let error: string | undefined;
  let cur: SimpleCommand = { assignments: [], words: [], redirects: [], stdinScript: false };
  let pendingRedirect: string | undefined;
  const heredocs: string[] = [];

  const flush = () => {
    if (pendingRedirect) {
      error ??= `redirezione ${pendingRedirect} senza destinazione`;
      pendingRedirect = undefined;
    }
    if (cur.words.length || cur.assignments.length || cur.redirects.length) commands.push(cur);
    cur = { assignments: [], words: [], redirects: [], stdinScript: false };
  };

  const pushWord = (w: Word) => {
    if (pendingRedirect) {
      cur.redirects.push({ op: pendingRedirect, target: w });
      if (pendingRedirect === '<<' || pendingRedirect === '<<-') heredocs.push(w.text);
      pendingRedirect = undefined;
      return;
    }
    if (!cur.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text) && !w.text.startsWith('=')) {
      cur.assignments.push(w.text);
      return;
    }
    cur.words.push(w);
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    // here-doc: dopo il fine riga si salta il corpo fino al delimitatore
    if (c === '\n' && heredocs.length) {
      flush();
      i++;
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        const end = s.indexOf(`\n${delim}`, i - 1);
        const lineEnd = end < 0 ? -1 : s.indexOf('\n', end + 1);
        if (end < 0) {
          error ??= `here-doc "${delim}" non terminato`;
          i = s.length;
        } else i = lineEnd < 0 ? s.length : lineEnd + 1;
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#') {
      // commento fino a fine riga (solo a inizio parola)
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    // redirezioni, con descrittore numerico opzionale
    const redir = /^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|>|<)/.exec(s.slice(i));
    if (redir && (redir[1] === '' || /\s|^$/.test(s[i - 1] ?? ' '))) {
      const op = redir[2]!;
      i += redir[0].length;
      if ((op === '>' || op === '<') && s[i] === '(') {
        const inner = readBalanced(s, i + 1, '(', ')');
        if (!inner) return { commands, substitutions, error: 'sostituzione di processo non chiusa' };
        substitutions.push(inner[0]);
        i = inner[1];
        cur.words.push({ text: '<(...)', dynamic: true, glob: false });
        continue;
      }
      if (op === '>&' && /^\d|^-/.test(s.slice(i))) {
        // duplicazione 2>&1 / >&-
        while (i < s.length && /[\d-]/.test(s[i]!)) i++;
        cur.redirects.push({ op: '>&' });
        continue;
      }
      if (op === '<<<') cur.stdinScript = true;
      if (op === '<<' || op === '<<-') cur.stdinScript = true;
      pendingRedirect = op;
      continue;
    }
    const opMatch = OPERATORS.find((o) => s.startsWith(o, i));
    if (opMatch) {
      flush();
      i += opMatch.length;
      continue;
    }
    // una parola
    let text = '';
    let dynamic = false;
    let glob = false;
    const startWord = i;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      if (OPERATORS.some((o) => o !== '(' && s.startsWith(o, i)) && !(ch === '(' || ch === ')')) break;
      if ((ch === '(' || ch === ')') && text === '' && i === startWord) break;
      if (ch === ')') break;
      if ((ch === '>' || ch === '<') && !(ch === '<' && s[i + 1] === '(')) break;
      if (ch === '\\') {
        // su Windows "\" è anche il separatore dei percorsi: si tiene così com'è se segue un carattere normale
        const nx = s[i + 1];
        if (nx === undefined) {
          i++;
          continue;
        }
        if (/[\s"'$`\\|&;<>()*?[\]{}]/.test(nx)) {
          text += nx;
          i += 2;
        } else {
          text += '\\';
          i++;
        }
        continue;
      }
      if (ch === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return { commands, substitutions, error: 'virgolette singole non chiuse' };
        text += s.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          const d = s[i]!;
          if (d === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1]!)) {
            text += s[i + 1];
            i += 2;
            continue;
          }
          if (d === '$' && s[i + 1] === '(') {
            const inner = readBalanced(s, i + 2, '(', ')');
            if (!inner) return { commands, substitutions, error: 'sostituzione $( ) non chiusa' };
            substitutions.push(inner[0]);
            dynamic = true;
            text += '$(…)';
            i = inner[1];
            continue;
          }
          if (d === '`') {
            const end = s.indexOf('`', i + 1);
            if (end < 0) return { commands, substitutions, error: 'backtick non chiuso' };
            substitutions.push(s.slice(i + 1, end));
            dynamic = true;
            text += '`…`';
            i = end + 1;
            continue;
          }
          if (d === '$' && /[A-Za-z_{@*#?!0-9-]/.test(s[i + 1] ?? '')) dynamic = true;
          if (d === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(s.slice(i))) dynamic = true;
          text += d;
          i++;
        }
        if (s[i] !== '"') return { commands, substitutions, error: 'virgolette doppie non chiuse' };
        i++;
        continue;
      }
      if (ch === '$' && s[i + 1] === '(') {
        const isArith = s[i + 2] === '(';
        const inner = readBalanced(s, i + 2, '(', ')');
        if (!inner) return { commands, substitutions, error: 'sostituzione $( ) non chiusa' };
        if (!isArith) substitutions.push(inner[0]);
        else substitutions.push(inner[0].replace(/^\(|\)$/g, ''));
        dynamic = true;
        text += '$(…)';
        i = inner[1];
        continue;
      }
      if (ch === '`') {
        const end = s.indexOf('`', i + 1);
        if (end < 0) return { commands, substitutions, error: 'backtick non chiuso' };
        substitutions.push(s.slice(i + 1, end));
        dynamic = true;
        text += '`…`';
        i = end + 1;
        continue;
      }
      if (ch === '$' && /[A-Za-z_{@*#?!0-9-]/.test(s[i + 1] ?? '')) dynamic = true;
      if (ch === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(s.slice(i))) dynamic = true;
      if (ch === '~' && text === '') dynamic = true;
      if (ch === '{' && /^\{[^}\s]*(,|\.\.)[^}\s]*\}/.test(s.slice(i))) dynamic = true;
      if (ch === '*' || ch === '?' || ch === '[') glob = true;
      text += ch;
      i++;
    }
    if (i === startWord) {
      // carattere non gestito: lo si salta segnalandolo
      error ??= `carattere non previsto "${s[i]}"`;
      i++;
      continue;
    }
    pushWord({ text, dynamic, glob });
  }
  flush();
  if (heredocs.length) error ??= 'here-doc senza corpo';
  return { commands, substitutions, ...(error ? { error } : {}) };
}

/** Nome del programma normalizzato: senza percorso, senza estensione, minuscolo. */
export function programName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}
