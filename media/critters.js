// CrewMon critters: three original pixel characters (Bot, Blob, Bug), one accessory per agent and a pose per state.
// Shared by the map (browser) and tools/gallery.js (Node). 24x24 grid, drawn with a -3 margin.
(function (root) {
  'use strict';
  const INK = '#1F2430';
  const STATE = {
    busy:    { fill: '#D97757' },
    idle:    { fill: '#4CAF7A' },
    machine: { fill: '#5B8DEF' },
    offline: { fill: '#8A8F98' },
  };
  const px = (cells, fill) => cells.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`).join('');

  // Each style: its body, its eyes (open or closed) and the anchors accessories sit on.
  //   top: the row the head starts on · eyes: the eye boxes · neck: where a scarf goes · left/right: body edges
  const STYLES = {
    bot: {   // a small crew robot: rounded head, dark visor with glowing eyes, ears, body and two feet
      anchor: { top: 5, eyes: [[9, 9, 2, 2], [13, 9, 2, 2]], neck: 15.8, left: 6, right: 18 },
      draw(fill, state) {
        const body = [[6, 5, 12, 1], [5, 6, 14, 9], [6, 15, 12, 1], [10, 16, 4, 1], [7, 17, 10, 3], [7, 20, 3, 1], [14, 20, 3, 1], [3, 9, 2, 3], [19, 9, 2, 3]];
        const glow = state === 'busy' ? '#FFE08A' : '#9FE3B4';
        const eyes = state === 'offline' ? px([[9, 10, 2, 1], [13, 10, 2, 1]], '#5A6275') : px([[9, 9, 2, 2], [13, 9, 2, 2]], glow);
        return px(body, fill) + px([[7, 8, 10, 4]], INK) + eyes;
      },
    },
    blob: {  // a round pixel slime with big shiny eyes
      anchor: { top: 6, eyes: [[8, 10, 2, 3], [14, 10, 2, 3]], neck: 15.2, left: 3, right: 21 },
      draw(fill, state) {
        const body = [[7, 6, 10, 1], [5, 7, 14, 1], [4, 8, 16, 2], [3, 10, 18, 6], [4, 16, 16, 2], [5, 18, 4, 1], [10, 18, 4, 1], [15, 18, 4, 1], [6, 19, 2, 1], [16, 19, 2, 1]];
        const eyes = state === 'offline' ? px([[8, 12, 2, 1], [14, 12, 2, 1]], INK)
          : px([[8, 10, 2, 3], [14, 10, 2, 3]], INK) + px([[8, 10, 1, 1], [14, 10, 1, 1]], '#ffffff');
        return px(body, fill) + eyes + px([[6, 14, 2, 1], [16, 14, 2, 1]], '#ffffff80');
      },
    },
    bug: {   // a round beetle with six tiny legs and a shell line
      anchor: { top: 5, eyes: [[8, 7, 2, 2], [14, 7, 2, 2]], neck: 12.6, left: 5, right: 19 },
      draw(fill, state) {
        const body = [[8, 5, 8, 1], [6, 6, 12, 2], [5, 8, 14, 8], [6, 16, 12, 2], [8, 18, 8, 1]];
        const legs = [[3, 9, 2, 1], [19, 9, 2, 1], [2, 12, 3, 1], [19, 12, 3, 1], [3, 15, 2, 1], [19, 15, 2, 1]];
        const eyes = state === 'offline' ? px([[8, 8, 2, 1], [14, 8, 2, 1]], INK) : px([[8, 7, 2, 2], [14, 7, 2, 2]], INK);
        return px(body.concat(legs), fill) + px([[11, 10, 2, 9]], INK + '55') + eyes;
      },
    },
  };

  // Accessories, placed from the style's anchors.
  const ACCESSORIES = {
    none:       () => '',
    tophat:     (A) => `<rect x="6" y="${A.top - 1.2}" width="12" height="1.2" fill="#3A3E4C" stroke="#C9CCD6" stroke-width="0.35"/><rect x="8" y="${A.top - 5.4}" width="8" height="4.2" fill="#3A3E4C" stroke="#C9CCD6" stroke-width="0.35"/><rect x="8" y="${A.top - 2.6}" width="8" height="0.8" fill="#C94F4F"/>`,
    antenna:    (A) => `<rect x="11.4" y="${A.top - 3.8}" width="1.2" height="3.8" fill="#C9CCD6"/><circle cx="12" cy="${A.top - 4}" r="1.5" fill="#F2C14E"/>`,
    crown:      (A) => `<path d="M6.5 ${A.top} L6.5 ${A.top - 3.4} L9.2 ${A.top - 1.6} L12 ${A.top - 4.4} L14.8 ${A.top - 1.6} L17.5 ${A.top - 3.4} L17.5 ${A.top} Z" fill="#F2C14E"/><circle cx="12" cy="${A.top - 2}" r="0.7" fill="#C94F4F"/>`,
    glasses:    (A) => {
      const [l, r] = A.eyes;
      const f = ([x, y, w, h]) => `<rect x="${x - 1.1}" y="${y - 1.2}" width="${w + 2.2}" height="${h + 2.4}" fill="none" stroke="#C9CCD6" stroke-width="0.9"/>`;
      return f(l) + f(r) + `<rect x="${l[0] + l[2] + 1.1}" y="${l[1] + l[3] / 2 - 0.4}" width="${r[0] - l[0] - l[2] - 2.2}" height="0.8" fill="#C9CCD6"/>`;
    },
    headphones: (A) => `<path d="M2.2 ${A.top + 3} V${A.top + 0.2} Q12 ${A.top - 7.6} 21.8 ${A.top + 0.2} V${A.top + 3}" fill="none" stroke="#C9CCD6" stroke-width="1.4"/><rect x="0.6" y="${A.top + 1.6}" width="2.8" height="4" rx="0.6" fill="${INK}" stroke="#C9CCD6" stroke-width="0.3"/><rect x="20.6" y="${A.top + 1.6}" width="2.8" height="4" rx="0.6" fill="${INK}" stroke="#C9CCD6" stroke-width="0.3"/>`,
    bow:        (A) => `<path d="M16 ${A.top - 1.8} L13.2 ${A.top - 4} L13.2 ${A.top + 0.4} Z M16 ${A.top - 1.8} L18.8 ${A.top - 4} L18.8 ${A.top + 0.4} Z" fill="#E86FA5"/><circle cx="16" cy="${A.top - 1.8}" r="0.9" fill="#C24E86"/>`,
    beanie:     (A) => `<path d="M3.5 ${A.top + 0.6} Q12 ${A.top - 7} 20.5 ${A.top + 0.6} Z" fill="#7B6CD9"/><rect x="3.5" y="${A.top - 0.4}" width="17" height="1.4" fill="#5D50B5"/><circle cx="12" cy="${A.top - 4.4}" r="1.1" fill="#ECEAF8"/>`,
    scarf:      (A) => `<rect x="${A.left}" y="${A.neck}" width="${A.right - A.left}" height="1.6" fill="#C94F4F"/><rect x="${A.right - 3.5}" y="${A.neck + 1.4}" width="1.6" height="3.6" fill="#C94F4F"/>`,
    party:      (A) => `<path d="M12 ${A.top - 5.6} L15.2 ${A.top} L8.8 ${A.top} Z" fill="#4FB3C9"/><rect x="9.6" y="${A.top - 1.8}" width="4.8" height="0.7" fill="#F2C14E"/><circle cx="12" cy="${A.top - 5.6}" r="0.8" fill="#F2C14E"/>`,
    cap:        (A) => `<path d="M4.5 ${A.top + 0.4} Q12 ${A.top - 5.4} 19.5 ${A.top + 0.4} Z" fill="#3E7CC9"/><rect x="13" y="${A.top - 0.8}" width="9" height="1.1" fill="#2F62A3"/>`,
    flower:     (A) => `<circle cx="18.5" cy="${A.top - 1.8}" r="1.1" fill="#F2C14E"/><circle cx="18.5" cy="${A.top - 3.4}" r="1" fill="#F49AC1"/><circle cx="18.5" cy="${A.top - 0.2}" r="1" fill="#F49AC1"/><circle cx="16.9" cy="${A.top - 1.8}" r="1" fill="#F49AC1"/><circle cx="20.1" cy="${A.top - 1.8}" r="1" fill="#F49AC1"/>`,
  };
  const ORDER = Object.keys(ACCESSORIES).filter(k => k !== 'none');

  function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function accessoryFor(id) { return ORDER[hash(id) % ORDER.length]; }

  function extras(state) {
    if (state === 'offline')    // asleep
      return `<text x="21.6" y="3" font-size="5" font-family="monospace" font-weight="700" fill="#C9CCD6" opacity="0.8">z</text>`;
    if (state === 'machine')    // kept running on the machine: a small server badge
      return `<rect x="19.2" y="15.6" width="5" height="5" rx="0.8" fill="${INK}" stroke="#C9CCD6" stroke-width="0.3"/><rect x="20" y="16.6" width="3.4" height="0.9" fill="#9FE3B4"/><rect x="20" y="18.4" width="3.4" height="0.9" fill="#9FE3B4"/>`;
    return '';
  }

  // opts: { id, state, size, accessory?, style? ('bot' | 'blob' | 'bug') } -> an <svg> string
  function critterSVG(opts) {
    const st = STATE[opts.state] || STATE.idle;
    const style = STYLES[opts.style] || STYLES.bot;
    const acc = opts.accessory || accessoryFor(opts.id || '');
    const op = opts.state === 'offline' ? 0.55 : 1;
    return `<svg class="critter" width="${opts.size}" height="${opts.size}" viewBox="-3 -3 30 30" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">` +
      `<g opacity="${op}">${style.draw(st.fill, opts.state)}</g>` +
      `<g shape-rendering="auto">${(ACCESSORIES[acc] || ACCESSORIES.none)(style.anchor)}${extras(opts.state)}</g></svg>`;
  }

  const api = { critterSVG, accessoryFor, ACCESSORY_NAMES: Object.keys(ACCESSORIES), STATES: Object.keys(STATE), STYLES: Object.keys(STYLES), STATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Critters = api;
})(typeof window !== 'undefined' ? window : this);
