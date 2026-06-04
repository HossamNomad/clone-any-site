// check-copy-truth.mjs
export function findStalePrices(text, canon) {
  const set = new Set(canon.map(c => c.replace(/\s/g,'')));
  const found = (text.match(/\d[\d  .,]{2,}/g) || []).map(s => s.trim()).filter(s => /\d{3,}/.test(s));
  return [...new Set(found.filter(s => !set.has(s.replace(/[\s.,]/g,'')) && !canon.includes(s)))];
}
