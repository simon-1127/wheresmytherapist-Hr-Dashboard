// HTML checkboxes with the same name arrive as an array when 2+ are
// checked, but as a bare string when exactly 1 is checked, and are simply
// absent when 0 are checked. Normalize all three to an array.
function toArray(val) {
  if (val === undefined || val === null || val === '') return [];
  return Array.isArray(val) ? val : [val];
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

module.exports = { toArray, toCsvArray, toIntOrNull };
