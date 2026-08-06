// HTML checkboxes with the same name arrive as an array when 2+ are
// checked, but as a bare string when exactly 1 is checked, and are simply
// absent when 0 are checked. Normalize all three to an array.
function toArray(val) {
  if (val === undefined || val === null || val === '') return [];
  return Array.isArray(val) ? val : [val];
}

// Reads a checkbox/multi-select group by its base name.
//
// express.urlencoded({ extended: true }) parses through qs, which CONSUMES
// the trailing [] — `goals[]=a&goals[]=b` arrives as { goals: ['a','b'] },
// so body['goals[]'] is always undefined and every one of these groups
// silently saved as an empty array. Reading both shapes keeps this correct
// whichever parser sits in front of it (extended: false would give the
// bracketed key instead).
function pickArray(body, name) {
  return toArray(body[name] ?? body[`${name}[]`]).filter(Boolean);
}

// "Mumbai, Bangalore,  Pune" -> ["Mumbai", "Bangalore", "Pune"]
function toCsvArray(val) {
  if (!val) return [];
  return String(val)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toIntOrNull(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

module.exports = { toArray, pickArray, toCsvArray, toIntOrNull };
