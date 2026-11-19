import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Shared browser module.
import { highlightCode } from '../web/code-highlight.js';

const plain = (html: string) => html.replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('build logs preserve exact text without leaking internal highlight markup', () => {
  const log = '> cmdk@0.1.19 build\nCJS dist/index.js 9.99 KB\nDTS dist/index.d.ts 4.70 KB';
  const html = highlightCode(log, 'code');
  assert.equal(plain(html), log);
  assert.doesNotMatch(html, /<span <span/);
});

test('keywords and numbers inside strings and comments are not highlighted again', () => {
  const source = 'const message = "class 0.1 # note"; // class 9.99';
  const html = highlightCode(source, 'ts');
  assert.equal(plain(html), source);
  assert.match(html, /<span class="hl-string">&quot;class 0\.1 # note&quot;<\/span>/);
  assert.match(html, /<span class="hl-comment">\/\/ class 9\.99<\/span>/);
  assert.doesNotMatch(html, /<span <span/);
});

test('source code keeps highlighting while literal HTML remains inert', () => {
  const source = 'class Widget { run() { return 9.99; } }';
  const html = highlightCode(source, 'js');
  assert.equal(plain(html), source);
  assert.match(html, /class="hl-keyword"/);
  assert.match(html, /class="hl-number"/);
  const literal = '<img src=x onerror=alert(1)> & text';
  assert.equal(plain(highlightCode(literal, 'html')), literal);
  assert.doesNotMatch(highlightCode(literal, 'html'), /<img\b/);
});
