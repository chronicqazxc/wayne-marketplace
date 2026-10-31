import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc, parseJsonc, jsoncRemoveServer } from '../jsonc.mjs';

describe('parseJsonc', () => {
  it('reads plain JSON', () => assert.deepEqual(parseJsonc('{"a":1}'), { a: 1 }));
  it('ignores line comments, also after a value', () => assert.deepEqual(parseJsonc('{\n // c\n "a": 1, // note\n "b": 2\n}'), { a: 1, b: 2 }));
  it('ignores block comments', () => assert.deepEqual(parseJsonc('{ /* x */ "a": /* y */ 1 }'), { a: 1 }));
  it('accepts trailing commas in objects and arrays', () => assert.deepEqual(parseJsonc('{"a":[1,2,],"b":{"c":1,},}'), { a: [1, 2], b: { c: 1 } }));
  it('does not change // inside a string', () => assert.deepEqual(parseJsonc('{"u":"http://x.y/z"}'), { u: 'http://x.y/z' }));
  it('does not change /* */ or ,} inside a string', () => assert.deepEqual(parseJsonc('{"u":"a /* b */ c ,} d"}'), { u: 'a /* b */ c ,} d' }));
  it('keeps an escaped quote inside a string', () => assert.deepEqual(parseJsonc('{"u":"a\\"//b"}'), { u: 'a"//b' }));
  it('throws on invalid JSON', () => assert.throws(() => parseJsonc('{"a":')));
  it('throws on an empty file', () => assert.throws(() => parseJsonc('')));
  it('stripJsonc keeps line breaks of removed line comments', () => assert.equal(stripJsonc('a // c\nb'), 'a \nb'));
  it('an unterminated block comment removes the rest', () => assert.equal(stripJsonc('a /* b'), 'a '));
});

const cfg = (servers, extra = '') => `{
  // top comment
  "model": "glm",
  "mcp": {
    "hub": { "type": "remote", "url": "http://x" },
    "servers": {
      // servers comment
${servers}
    }
  }${extra}
}
`;
const e = (n, last = false) => `      "${n}": { "type": "local", "command": ["bash", "-c", "x {y}, \\"z\\""] }${last ? '' : ','}`;

describe('jsoncRemoveServer', () => {
  it('removes the first entry and keeps comments and other entries', () => {
    const t = cfg([e('a'), e('b'), e('c', true)].join('\n'));
    const out = jsoncRemoveServer(t, 'a');
    assert.ok(out.includes('// top comment') && out.includes('// servers comment'));
    assert.deepEqual(Object.keys(parseJsonc(out).mcp.servers), ['b', 'c']);
    assert.ok(!out.includes('"a"'));
  });
  it('removes a middle entry', () => {
    const out = jsoncRemoveServer(cfg([e('a'), e('b'), e('c', true)].join('\n')), 'b');
    assert.deepEqual(Object.keys(parseJsonc(out).mcp.servers), ['a', 'c']);
  });
  it('removes the last entry and the comma before it', () => {
    const out = jsoncRemoveServer(cfg([e('a'), e('b', true)].join('\n')), 'b');
    assert.deepEqual(Object.keys(parseJsonc(out).mcp.servers), ['a']);
  });
  it('removes the only entry', () => {
    const out = jsoncRemoveServer(cfg(e('a', true)), 'a');
    assert.deepEqual(parseJsonc(out).mcp.servers, {});
    assert.ok(out.includes('// servers comment'));
  });
  it('removes an entry from the flat shape mcp.<name>', () => {
    const t = '{\n  "mcp": {\n    "a": { "type": "local" },\n    "b": { "type": "local" }\n  }\n}\n';
    assert.deepEqual(Object.keys(parseJsonc(jsoncRemoveServer(t, 'a')).mcp), ['b']);
  });
  it('removes an entry that has a trailing comma after the last item', () => {
    const t = '{\n  "mcp": {\n    "servers": {\n      "a": { "x": 1 },\n      "b": { "x": 2 },\n    },\n  },\n}\n';
    assert.deepEqual(Object.keys(parseJsonc(jsoncRemoveServer(t, 'b')).mcp.servers), ['a']);
  });
  it('removes the whole line (no blank line is left)', () => {
    const out = jsoncRemoveServer(cfg([e('a'), e('b', true)].join('\n')), 'a');
    assert.ok(!/\n\s*\n/.test(out.split('// servers comment')[1].split('}')[0]));
  });
  it('works with an entry on one line with the closing brace', () => {
    const t = '{"mcp":{"servers":{"a":{"x":1},"b":{"x":2}}}}';
    assert.deepEqual(parseJsonc(jsoncRemoveServer(t, 'a')), { mcp: { servers: { b: { x: 2 } } } });
  });
  it('works with Windows line breaks', () => {
    const t = cfg([e('a'), e('b', true)].join('\n')).replaceAll('\n', '\r\n');
    assert.deepEqual(Object.keys(parseJsonc(jsoncRemoveServer(t, 'a')).mcp.servers), ['b']);
  });
  it('works with block comments inside the object', () => {
    const t = '{"mcp":{"servers":{ /* c */ "a":{"x":1}, "b":{"x":2} }}}';
    assert.deepEqual(Object.keys(parseJsonc(jsoncRemoveServer(t, 'a')).mcp.servers), ['b']);
  });
  it('is not confused by braces, commas and quotes inside strings', () => {
    const t = cfg([e('a'), e('b', true)].join('\n'));
    assert.deepEqual(parseJsonc(jsoncRemoveServer(t, 'b')).mcp.servers.a.command[2], 'x {y}, "z"');
  });
  it('returns null when the entry does not exist', () => assert.equal(jsoncRemoveServer(cfg(e('a', true)), 'nope'), null));
  it('does not remove the "servers" container itself', () => assert.equal(jsoncRemoveServer(cfg(e('a', true)), 'servers'), null));
  it('does not remove a key with the same name in another section', () => {
    const t = '{"agent":{"a":{"x":1}},"mcp":{"servers":{"b":{"x":2}}}}';
    assert.equal(jsoncRemoveServer(t, 'a'), null);
  });
  it('does not remove a key that is deeper inside an entry', () => {
    const t = '{"mcp":{"servers":{"b":{"a":{"x":2}}}}}';
    assert.equal(jsoncRemoveServer(t, 'a'), null);
  });
  it('returns null for invalid JSON text', () => assert.equal(jsoncRemoveServer('{"mcp":{"servers":{"a":', 'a'), null));
  it('returns null for an empty text', () => assert.equal(jsoncRemoveServer('', 'a'), null));
  it('returns null when there is no mcp section', () => assert.equal(jsoncRemoveServer('{"a":1}', 'a'), null));
  it('removes only the first match if the name is twice in the file', () => {
    const t = '{"mcp":{"servers":{"a":{"x":1}}}}';
    assert.equal(jsoncRemoveServer(jsoncRemoveServer(t, 'a'), 'a'), null);
  });
  it('keeps text after the object unchanged', () => {
    const out = jsoncRemoveServer(cfg(e('a', true), ',\n  "after": 1'), 'a');
    assert.equal(parseJsonc(out).after, 1);
  });
  it('returns null instead of broken text when a comment sits between the entry and its comma', () => {
    // cutting the entry here would leave "{ // c\n ,"b":..." which is not valid JSON
    const text = '{"mcp":{"servers":{"a":{"x":1} // c\n,"b":{"y":2}}}}';
    assert.equal(jsoncRemoveServer(text, 'a'), null);
  });
  it('returns null when the removal would change other data', () => {
    const text = '{"mcp":{"servers":{"a":{"x":1}, "b":{"y":2}}}}';
    assert.notEqual(jsoncRemoveServer(text, 'a'), null);
    assert.deepEqual(parseJsonc(jsoncRemoveServer(text, 'a')), { mcp: { servers: { b: { y: 2 } } } });
  });
});
