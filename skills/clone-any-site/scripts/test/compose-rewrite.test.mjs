import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteEntryHtml } from '../lib/compose-rewrite.mjs';

const MAP = { slots: [ { id:'IMG-1', type:'image', original:'https://images.ctfassets.net/x/y/hero.jpg' } ] };
const SWAPS = { 'IMG-1': { type:'image', file:'.generated/IMG-1.webp' }, 'TITLE-1': { type:'text', value:'PULSIA' } };

test('rewriteEntryHtml swaps the CDN url, kills SW, injects the DOM-swap script', () => {
  const html = '<head></head><body><img src="https://images.ctfassets.net/x/y/hero.jpg"><h1>BAIKAL</h1></body>';
  const out = rewriteEntryHtml(html, MAP, SWAPS);
  assert.match(out, /\/__swap\/IMG-1/);                 // CDN url rewritten
  assert.doesNotMatch(out, /images\.ctfassets\.net\/x\/y\/hero\.jpg/);
  assert.match(out, /serviceWorker/);                    // SW kill injected
  assert.match(out, /__CL_SWAPS__/);                     // DOM-swap payload injected
});

test('image slot with a non-HTML (blob) original is DOM-swapped by cssPath', () => {
  const map = { slots: [ { id:'IMG-9', type:'image', original:'blob:http://127.0.0.1:9/abc', where:{ cssPath:'main > img:nth-of-type(1)' } } ] };
  const swaps = { 'IMG-9': { type:'image', file:'.generated/IMG-9.webp' } };
  const html = '<head></head><body><main><img src="blah"></main></body>';
  const out = rewriteEntryHtml(html, map, swaps);
  assert.match(out, /__CL_SWAPS__/);
  assert.match(out, /"kind":"image"/);                       // image entry in the DOM payload
  assert.match(out, /main > img:nth-of-type\(1\)/);          // its cssPath is carried
  assert.match(out, /\/__swap\/IMG-9/);                       // swap url present
  assert.match(out, /querySelectorAll/);                      // client image-swap logic injected
});

test('split-text slot emits a splittext payload (distributes our words, keeps the reveal elements)', () => {
  const map = { slots: [ { id:'TITLE-7', type:'title', text:'Un endroit extreme', split:true, where:{ cssPath:'section > h2' } } ] };
  const swaps = { 'TITLE-7': { type:'text', value:'Fourteen days, one protocol' } };
  const html = '<head></head><body><section><h2><span>Un</span><span>endroit</span><span>extreme</span></h2></section></body>';
  const out = rewriteEntryHtml(html, map, swaps);
  assert.match(out, /"kind":"splittext"/);                    // split-text payload, not plain text
  assert.match(out, /section > h2/);                          // container cssPath carried
  assert.match(out, /Fourteen days, one protocol/);           // our value present
  assert.match(out, /leaves/);                                // animation-safe distribution logic injected
});
