'use strict';

const { FAIL, WARN, PASS, INFO, SKIP } = require('./checks.js');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

const MARK = {
  [PASS]: () => c('32', 'PASS'),
  [FAIL]: () => c('31', 'FAIL'),
  [WARN]: () => c('33', 'WARN'),
  [INFO]: () => c('36', 'INFO'),
  [SKIP]: () => c('90', 'SKIP'),
};

const RANK = { [FAIL]: 0, [WARN]: 1, [INFO]: 2, [PASS]: 3, [SKIP]: 4 };

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

// Problems first. A report that opens with eleven PASS lines gets skimmed and
// the one FAIL at the bottom gets missed.
function sortResults(results) {
  return results.slice().sort((a, b) => RANK[a.status] - RANK[b.status]);
}

function render(results, meta) {
  const width = Math.min(process.stdout.columns || 80, 100);
  const indent = ' '.repeat(7);
  const out = [];
  const m = meta || {};

  out.push('');
  out.push(c('1', 'expo-preflight') + c('90', '  ·  what App Review will reject, before you build'));
  if (m.configSource) {
    out.push(
      c('90', `  ${m.configSource}${m.configEvaluated ? '' : ' (could not evaluate, read statically)'}${m.appName ? '  ·  ' + m.appName : ''}${m.version ? ' v' + m.version : ''}`)
    );
  }
  out.push('');

  for (const r of sortResults(results)) {
    if (r.status === SKIP && !m.verbose) continue;
    out.push(`${MARK[r.status] ? MARK[r.status]() : r.status}  ${c('1', r.title)}`);
    out.push(indent + c('90', wrap(r.detail, width - 8, indent)));
    if (r.rejects && (r.status === FAIL || r.status === WARN)) {
      out.push(indent + c('35', 'costs  ') + c('90', wrap(r.rejects, width - 15, indent + '       ')));
    }
    if (r.fix && (r.status === FAIL || r.status === WARN)) {
      out.push(indent + c('36', 'fix    ') + wrap(r.fix, width - 15, indent + '       '));
    }
    out.push('');
  }

  const fails = results.filter((r) => r.status === FAIL);
  const warns = results.filter((r) => r.status === WARN);
  const skipped = results.filter((r) => r.status === SKIP);

  if (fails.length) {
    out.push(
      c('31', `${fails.length} blocking problem${fails.length > 1 ? 's' : ''}`) +
        c('90', `, ${warns.length} warning${warns.length === 1 ? '' : 's'}.`)
    );
    out.push(c('90', 'Each blocking problem above either fails at upload or gets rejected in review.'));
  } else if (warns.length) {
    out.push(
      c('33', `No blockers, ${warns.length} warning${warns.length > 1 ? 's' : ''}.`) +
        c('90', ' Worth a look before you spend build minutes.')
    );
  } else {
    out.push(c('32', 'No problems found.') + c('90', ' Nothing here that this tool knows how to catch.'));
  }

  if (skipped.length && !m.verbose) {
    out.push(c('90', `${skipped.length} check${skipped.length > 1 ? 's' : ''} not applicable. --verbose to see them.`));
  }
  if (m.configSource && !m.configEvaluated) {
    out.push(
      c('33', 'Note: ') +
        c('90', `${m.configSource} could not be evaluated, so config-based checks read a static fallback and may be wrong. Make sure npx expo config --json works here.`)
    );
  }
  out.push('');
  return out.join('\n');
}

function renderJson(results, meta) {
  const fails = results.filter((r) => r.status === FAIL);
  const warns = results.filter((r) => r.status === WARN);
  return JSON.stringify(
    {
      ok: fails.length === 0,
      summary: {
        fail: fails.length,
        warn: warns.length,
        pass: results.filter((r) => r.status === PASS).length,
        info: results.filter((r) => r.status === INFO).length,
        skip: results.filter((r) => r.status === SKIP).length,
      },
      meta: meta || {},
      results: sortResults(results),
    },
    null,
    2
  );
}

module.exports = { render, renderJson, sortResults };
