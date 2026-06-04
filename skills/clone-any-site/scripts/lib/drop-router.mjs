// lib/drop-router.mjs
// Pure router: dropped filename (named after a slot tag) -> routing decision,
// validated against a clone's MAP.json slots. Deterministic, no fs/network.
import { PREFIX, COLORS } from './slot-infer.mjs';

// Reverse map: prefix -> type (e.g. 'VID' -> 'video')
const TYPE_BY_PREFIX = Object.fromEntries(Object.entries(PREFIX).map(([type, p]) => [p, type]));

// Droppable prefixes (TITLE/TXT are edited in swaps.json, not dropped).
const DROP_PREFIXES = [PREFIX.image, PREFIX.video, PREFIX.sequence]; // IMG, VID, SEQ
const TEXT_PREFIXES = [PREFIX.title, PREFIX.text];                   // TITLE, TXT

// Extension -> expected type.
const EXT_TYPE = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', avif: 'image', gif: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  zip: 'sequence',
};

const FILENAME_RE = /^([A-Za-z]+)-(\d+)\.([A-Za-z0-9]+)$/;

/**
 * Turn a dropped filename into a routing decision.
 * @param {string} filename e.g. "VID-04.mp4"
 * @returns {{ok:true,id,prefix,type,num,ext}|{ok:false,error:string}}
 */
export function routeDrop(filename) {
  const m = String(filename).match(FILENAME_RE);
  if (!m) {
    return { ok: false, error: `"${filename}" does not match the expected pattern PREFIX-N.ext (e.g. VID-04.mp4, IMG-12.jpg, SEQ-01.zip).` };
  }

  const prefix = m[1].toUpperCase();
  const num = parseInt(m[2], 10); // strips leading zeros
  const ext = m[3].toLowerCase();

  // Text slots are edited in swaps.json, never dropped.
  if (TEXT_PREFIXES.includes(prefix)) {
    return { ok: false, error: `${prefix} is a text slot — text is edited in swaps.json, not dropped.` };
  }

  // Must be a known droppable prefix.
  if (!DROP_PREFIXES.includes(prefix)) {
    return { ok: false, error: `Unknown prefix "${prefix}". Valid prefixes: ${DROP_PREFIXES.join(', ')}.` };
  }

  const prefixType = TYPE_BY_PREFIX[prefix];
  const extType = EXT_TYPE[ext];

  if (!extType) {
    return { ok: false, error: `Unknown extension ".${ext}". Use an image (jpg/jpeg/png/webp/avif/gif), video (mp4/webm/mov/m4v), or sequence (zip) file.` };
  }

  if (extType !== prefixType) {
    return { ok: false, error: `Extension/prefix conflict: ".${ext}" is a ${extType} file but ${prefix} is a ${prefixType} slot.` };
  }

  const id = `${prefix}-${num}`; // no leading zeros
  return { ok: true, id, prefix, type: prefixType, num, ext };
}

/**
 * Validate a route against a clone's MAP.json slots array.
 * @param {{ok:boolean,id?:string,type?:string}} route output of routeDrop
 * @param {Array<{id:string,type:string}>} mapSlots MAP.json `slots`
 * @returns {{ok:true,slot}|{ok:false,error:string}}
 */
export function validateAgainstMap(route, mapSlots) {
  if (!route || route.ok !== true) {
    return { ok: false, error: 'route is not a valid drop (route.ok must be true).' };
  }
  const slots = Array.isArray(mapSlots) ? mapSlots : [];
  const byId = slots.find((s) => s && s.id === route.id);

  if (!byId) {
    const validIds = slots.filter((s) => s && s.type === route.type).map((s) => s.id);
    const list = validIds.length ? validIds.join(', ') : '(none)';
    return { ok: false, error: `no slot ${route.id}; valid ${route.type} slots: ${list}` };
  }

  if (byId.type !== route.type) {
    return { ok: false, error: `slot ${route.id} exists but is type ${byId.type}, not ${route.type}.` };
  }

  return { ok: true, slot: byId };
}

/**
 * Hex color for a slot type.
 * @param {string} type e.g. 'video'
 * @returns {string|undefined}
 */
export function colorFor(type) {
  return COLORS[type];
}
