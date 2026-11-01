import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { rulesPayload, sameRules } from '../scripts/publish-rules.mjs';

test('the real rules file is a valid payload', () => {
  const { rules } = rulesPayload(fs.readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'));
  assert.ok(rules.rules.lists);
});
test('rulesPayload refuses files that are not rules', () => {
  assert.throws(() => rulesPayload('{nope'), /not valid JSON/);
  assert.throws(() => rulesPayload('{}'), /no "rules"/);
  assert.throws(() => rulesPayload('{"rules": []}'), /no "rules"/);
  assert.throws(() => rulesPayload('null'), /no "rules"/);
});
test('sameRules ignores key order and whitespace, and spots a difference', () => {
  const a = { rules: { '.read': false, lists: { x: 1 } } };
  assert.ok(sameRules(a, '{ "rules": { "lists": {"x":1}, ".read": false } }'));
  assert.ok(!sameRules(a, '{"rules":{".read":true,"lists":{"x":1}}}'));
  assert.ok(!sameRules(a, '// comment\n{"rules":{}}'), 'unparsable live text counts as different');
});
test('the workflow publishes dev on push, production on a release or by hand, dev first', () => {
  const y = fs.readFileSync(new URL('../.github/workflows/rules.yml', import.meta.url), 'utf8');
  assert.match(y, /push:\s+branches: \[main\]/);
  assert.match(y, /needs: dev/);
  assert.match(y, /release:\s+types: \[published\]/);
  assert.match(y, /production:[\s\S]*github\.event_name == 'release'/);
});
