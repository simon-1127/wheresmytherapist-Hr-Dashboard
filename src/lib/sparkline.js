// The mood chart used to be an EJS partial pulled in with `include()` from
// inside a forEach callback. That threw "include is not a function" on the
// deployed app — `include` is passed into a compiled EJS template as a
// function argument, and whether it survives into a nested scope depends on
// the EJS version and compile options. Building the SVG string in plain JS
// sidesteps the whole question and is easier to unit test besides.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(
    /[&<>"']/g,
    (c) => ESCAPES[c],
  );
}

/**
 * Renders one check-in series as an inline SVG sparkline.
 *
 * Values arrive already normalized to 0-100 (`pct`) because different
 * check-in questions use different slider ranges; the axis labels are
 * mapped back to the question's own scale so the numbers still read right.
 */
function sparklineSvg(series, opts = {}) {
  const W = opts.width || 640;
  const H = opts.height || 140;
  const PAD_L = 34;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const pts = series.points || [];
  if (!pts.length) return '';

  const min = series.min === null || series.min === undefined ? 0 : series.min;
  const max = series.max === null || series.max === undefined ? 10 : series.max;

  const xAt = (i) => PAD_L + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const yAt = (pct) => PAD_T + innerH - (pct / 100) * innerH;

  const parts = [];
  parts.push(
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" ` +
      `aria-label="Trend for ${esc(series.label)}" style="display:block;">`,
  );

  [0, 50, 100].forEach((g) => {
    const y = yAt(g).toFixed(1);
    const tick = Math.round(min + (max - min) * (g / 100));
    parts.push(
      `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="var(--support-grid,#e5e7eb)" stroke-width="1" />`,
      `<text x="${PAD_L - 6}" y="${(yAt(g) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${tick}</text>`,
    );
  });

  if (pts.length > 1) {
    const line = pts.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.pct).toFixed(1)}`).join(' ');
    parts.push(
      `<polyline points="${line}" fill="none" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`,
    );
  }

  const r = pts.length > 40 ? 1.8 : 3;
  pts.forEach((p, i) => {
    // Bottom-quartile readings are the ones a support agent is scanning for,
    // so they get called out rather than blending into the line.
    const fill = p.pct <= 25 ? '#dc2626' : '#4f46e5';
    parts.push(
      `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.pct).toFixed(1)}" r="${r}" fill="${fill}">` +
        `<title>${esc(p.date)}: ${esc(p.value)}</title></circle>`,
    );
  });

  parts.push(
    `<text x="${PAD_L}" y="${H - 6}" font-size="9" fill="#9ca3af">${esc(pts[0].date)}</text>`,
    `<text x="${W - PAD_R}" y="${H - 6}" font-size="9" fill="#9ca3af" text-anchor="end">${esc(pts[pts.length - 1].date)}</text>`,
    '</svg>',
  );

  return parts.join('');
}

module.exports = { sparklineSvg };
