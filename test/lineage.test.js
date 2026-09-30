const test = require('node:test');
const assert = require('node:assert');
const { analyzeLineage } = require('../src/lineage');
const { saveTriageEntry } = require('../src/store');

test('analyzeLineage processes empty ledger gracefully', () => {
  const result = analyzeLineage({ signals: [] }, { projects: [] }, [], []);
  assert.strictEqual(result.chains.length, 0);
});

test('saveTriageEntry validates actions', () => {
  assert.throws(() => {
    saveTriageEntry({ key: 'test', kind: 'stalled', action: 'bad_action' });
  }, /Invalid action/);
});
