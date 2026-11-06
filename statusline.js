'use strict'
// Claude Code status line. Receives the session JSON on stdin, prints one
// adaptive row. Docs: https://code.claude.com/docs/en/statusline
const { execFileSync } = require('child_process')
const fs = require('fs')
// win32.basename splits on both / and \, whatever separator the payload uses.
const basename = require('path').win32.basename

// Notifications and the verbose-mode token counter render on the right of this
// same row, so never claim the full terminal width.
const RESERVE = 12
const BAR_W = 10
const BAR_CH = '-'
const DIM = '\x1b[90m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
// Palette index, not a hex: this is the tone oh-my-zsh ships, and as an index
// it follows the terminal theme instead of pinning one color.
const BLUE = '\x1b[34m'
// Claude brand coral #d97757. 24-bit where the terminal advertises it,
// nearest xterm-256 index otherwise.
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM || '')
const CORAL = TRUECOLOR ? '\x1b[38;2;217;119;87m' : '\x1b[38;5;173m'
// Gauge labels. One shared accent groups the three meters and keeps
// green/yellow/red free to mean "warning". #a78bfa, nearest 256 index is 141.
const VIOLET = TRUECOLOR ? '\x1b[38;2;167;139;250m' : '\x1b[38;5;141m'
// Wall clock. #39ff14, nearest 256 index is 82.
const NEON = TRUECOLOR ? '\x1b[38;2;57;255;20m' : '\x1b[38;5;82m'
// Marker for the whole row, so it survives every drop. Kept out of the segment
// list to avoid glue-ordering complexity; its width is billed to the fit budget.
const PREFIX_W = 3
const PREFIX = VIOLET + '❯' + RESET + NEON + '❯' + RESET + ' '
// Leads the wrapped row, putting the meters in the same column as the directory.
// U+2800 is a braille cell with no dots: it draws as blank, is one column wide,
// and is not whitespace -- plain spaces here get stripped by the Ink renderer.
const INDENT_W = 3
const INDENT = String.fromCharCode(0x2800).repeat(INDENT_W)
// Single source of truth: the plain form is measured, the colored form printed.
const SEP_CH = '\u00b7'

const colorFor = (p) => (p >= 90 ? RED : p >= 70 ? '\x1b[33m' : '\x1b[32m')

// Fixed-width rule. The leading run is colored by threshold, the rest stays dim,
// so the segment's width never shifts as the value moves.
function bar(p) {
  const filled = Math.max(0, Math.min(BAR_W, Math.round((p / 100) * BAR_W)))
  return { on: BAR_CH.repeat(filled), off: BAR_CH.repeat(BAR_W - filled) }
}

function countdown(epochSeconds) {
  if (typeof epochSeconds !== 'number' || !isFinite(epochSeconds)) return ''
  let s = Math.floor(epochSeconds - Date.now() / 1000)
  if (s <= 0) return ''
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60)
  if (d > 0) return d + 'd' + h + 'h'
  if (h > 0) return h + 'h' + m + 'm'
  return m + 'm'
}

// Branch name only. symbolic-ref answers even in a repo with no commits yet,
// and exits 1 on a detached HEAD -- the one case worth a second call, where the
// short SHA stands in. Any other failure (128 = not a repo) gives up at once.
function gitBranch(cwd) {
  const run = (args) => execFileSync(
    'git',
    ['--no-optional-locks'].concat(args),
    { cwd, timeout: 800, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
  ).trim()
  try {
    return run(['symbolic-ref', '--quiet', '--short', 'HEAD']) || null
  } catch (e) {
    if (e && e.status !== 1) return null
    try {
      return run(['rev-parse', '--short', 'HEAD']) || null
    } catch (e2) {
      return null
    }
  }
}

// A gauge cell: dim label, threshold-colored rule, percentage, optional suffix.
// A value that is unknown, empty, or rounds to zero prints a bare "%".
function gauge(label, pct, suffix) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
  const c = colorFor(p)
  const num = p > 0 ? String(p) : ''
  const b = bar(p)
  const tail = suffix ? ' (' + suffix + ')' : ''
  return {
    plain: label + ' ' + b.on + b.off + ' ' + num + '%' + tail,
    colored:
      VIOLET + label + RESET + ' ' + c + b.on + RESET + DIM + b.off + RESET +
      ' ' + c + num + '%' + RESET + DIM + tail + RESET,
  }
}

function build(d) {
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd()
  const dir = basename(cwd.replace(/[\/]+$/, '')) || cwd
  const segs = []

  // priority 1 never drops; higher numbers drop first. row 2 is the wrapped
  // row, used only when everything will not fit on one.
  segs.push({
    row: 1,
    prio: 5,
    plain: dir,
    colored: CYAN + dir + RESET,
  })

  const branch = gitBranch(cwd)
  if (branch) {
    segs.push({
      row: 1,
      prio: 3,
      glue: ' ',
      plain: 'git:(' + branch + ')',
      colored: BLUE + 'git:(' + RESET + RED + branch + RESET + BLUE + ')' + RESET,
    })
  }

  // Trails the location cell, or stands alone if both parts above were dropped.
  // Cheapest segment on the line, so it drops first: shedding it when barely
  // over the limit saves a whole gauge from going instead.
  const now = new Date()
  const clock = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0')
  segs.push({
    row: 1,
    prio: 7,
    glue: ' ',
    plain: clock,
    colored: NEON + clock + RESET,
  })

  // The payload's display name carries a variant suffix for some models
  // ("Opus 5 (1M context)"). The row has no columns to spare for it.
  const model = ((d.model && d.model.display_name) || '').replace(/\s*\([^()]*\)\s*$/, '')
  if (model) {
    const lvl = d.effort && d.effort.level ? d.effort.level : null
    segs.push({
      row: 1,
      prio: 2,
      plain: model + (lvl ? ' / ' + lvl : ''),
      colored: CORAL + model + RESET + (lvl ? DIM + ' / ' + lvl + RESET : ''),
    })
  }

  const ctx = d.context_window || {}
  segs.push(Object.assign({ row: 2, prio: 1 }, gauge('ctx', ctx.used_percentage || 0)))

  const rl = d.rate_limits || {}
  if (rl.five_hour) {
    segs.push(Object.assign({ row: 2, prio: 4 },
      gauge('5h', rl.five_hour.used_percentage || 0, countdown(rl.five_hour.resets_at))))
  }
  if (rl.seven_day) {
    segs.push(Object.assign({ row: 2, prio: 6 },
      gauge('7d', rl.seven_day.used_percentage || 0, countdown(rl.seven_day.resets_at))))
  }
  return segs
}

function render(segs, key) {
  const sep = ' ' + (key === 'plain' ? SEP_CH : DIM + SEP_CH + RESET) + ' '
  let out = ''
  segs.forEach((s, i) => {
    if (i > 0) out += s.glue !== undefined ? s.glue : sep
    out += s[key]
  })
  return out
}

// Shed segments, cheapest-and-least-wanted first, until the row fits. Priority 1
// is exempt, so this can return a row that is still too wide rather than empty.
function fit(segs, limit) {
  const kept = segs.slice()
  while (render(kept, 'plain').length > limit) {
    let worst = -1
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].prio > 1 && (worst === -1 || kept[i].prio > kept[worst].prio)) worst = i
    }
    if (worst === -1) break
    kept.splice(worst, 1)
  }
  return kept
}

function main() {
  let d = {}
  try {
    d = JSON.parse(fs.readFileSync(0, 'utf8')) || {}
  } catch (e) {
    d = {}
  }

  const segs = build(d)
  // RESERVE comes off both rows: notifications share "the same row as your
  // status line", and with two rows it is unspecified which, so both leave room.
  const budget = (parseInt(process.env.COLUMNS, 10) || 80) - RESERVE

  if (PREFIX_W + render(segs, 'plain').length <= budget) {
    console.log(PREFIX + render(segs, 'colored'))
    return
  }
  const top = fit(segs.filter((s) => s.row === 1), budget - PREFIX_W)
  if (top.length === 0) {
    // Nothing survived up top, so carry the marker down rather than spending a
    // whole row on a bare "❯❯".
    const only = fit(segs.filter((s) => s.row === 2), budget - PREFIX_W)
    console.log(PREFIX + render(only, 'colored'))
    return
  }
  console.log(PREFIX + render(top, 'colored'))
  console.log(INDENT + render(fit(segs.filter((s) => s.row === 2), budget - INDENT_W), 'colored'))
}

try {
  main()
} catch (e) {
  try {
    console.log(basename(process.cwd()) || 'claude')
  } catch (e2) {
    console.log('claude')
  }
}
