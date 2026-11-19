// Preview sheet of every critter: rows = accessories, columns = states, for one style.
//   node tools/gallery.js [bot|blob|bug] > docs/critters.svg      node tools/gallery.js styles > docs/styles.svg
const C = require('../media/critters.js');
const cell = 64, padL = 90, padT = 30, arg = process.argv[2] || 'bot';
const rows = arg === 'styles' ? C.STYLES : C.ACCESSORY_NAMES, cols = C.STATES;
let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${padL + cols.length * cell + 10}" height="${padT + rows.length * cell + 10}" font-family="sans-serif" font-size="12">`;
out += `<rect width="100%" height="100%" fill="#1F2430"/>`;
cols.forEach((s, j) => { out += `<text x="${padL + j * cell + cell / 2}" y="20" fill="#C9CCD6" text-anchor="middle">${s}</text>`; });
rows.forEach((r, i) => {
  out += `<text x="10" y="${padT + i * cell + cell / 2 + 4}" fill="#C9CCD6">${r}</text>`;
  cols.forEach((s, j) => {
    const o = arg === 'styles' ? { id: r, state: s, size: 56, style: r, accessory: 'none' } : { id: r, state: s, size: 56, style: arg, accessory: r };
    const inner = C.critterSVG(o).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    out += `<g transform="translate(${padL + j * cell + 4},${padT + i * cell + 4}) scale(${56 / 30}) translate(3,3)">${inner}</g>`;
  });
});
console.log(out + '</svg>');
