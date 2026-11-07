import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/Engine.js';

// Reasons (src/plan/reasons.js): why a candidate is attractive, as text. The
// facts on the left-hand side of the rules that set the numerics its utility
// reads, rendered with their predicates' text templates; `for` when the rule
// pushed the utility up, `against` when down. No utility, value or weight.

function build() {
  const engine = new Engine({
    predicates: { predicates: {
      actionType: { type: 'boolean', args: ['occurrence', 'action'] },
      role:       { type: 'boolean', args: ['occurrence', 'roleName', 'entity'] },
      likes:      { type: 'numeric', args: ['agent', 'agent'], minValue: 0, maxValue: 10, default: 5,
                    toString: { briefing: 'You like {args[1]} {value} out of 10.' } },
      called:     { type: 'boolean', args: ['occurrence', 'text'],
                    toString: { briefing: 'You called "{text[0]}" {args[1]}.' } },
      quiet:      { type: 'boolean', args: ['agent'] },
      hostile:    { type: 'numeric', args: ['agent', 'agent'], default: 0, annotations: { ephemeral: true } },
      charitable: { type: 'numeric', args: ['agent'], default: 0, annotations: { ephemeral: true } },
    }},
    entities: { agent: { privateStore: true, alice: {}, bob: {}, carol: {} } },
  });
  const { occurrence } = engine.performExternal({
    actionType: 'took from',
    roles: { SELF: 'bob', OTHER: 'alice' },
    effects: ['alice.called(?occ, "selfish")', 'alice.likes(alice, bob) = 2'],
    text: 'bob took 2 coins from alice',
  });
  engine.assert('quiet(alice)');
  engine.loadRules(`
    ruleset "priming"
      rule "dislike makes hostile"
        ?SELF.likes(?SELF, ?B) < 5
        => hostile(?SELF, ?B) += 3
      rule "dislike makes less charitable"
        ?SELF.likes(?SELF, ?B) < 5
        => charitable(?SELF) -= 1
      rule "calling something selfish makes less charitable"
        ?SELF.called(?O, "selfish")
        => charitable(?SELF) -= 1
      rule "being quiet makes charitable"
        quiet(?SELF)
        => charitable(?SELF) += 1
  `);
  engine.loadActions(`
    actionset "acts"
      action "blame"
        roles: ?SELF: agent, ?X: agent
        utility
          hostile(?SELF, ?X) + charitable(?SELF) / 2
        content text: "?SELF blames ?X"
      action "forgive"
        roles: ?SELF: agent, ?X: agent
        utility
          charitable(?SELF) - hostile(?SELF, ?X)
        content text: "?SELF forgives ?X"
  `);
  engine.runRulesetSingle('priming', { startingBinding: { SELF: 'alice' } });
  const candidates = engine.scoreActionset('acts', { SELF: 'alice' });
  const reasons = label => engine.reasonsFor(candidates.find(c => c.label === label))
    .map(({ direction, text }) => `${direction}: ${text}`);
  return { engine, occurrence, reasons };
}

describe('reasons', () => {
  it('renders the facts behind a utility, for or against, each once', () => {
    const { reasons } = build();
    assert.deepEqual(reasons('alice blames bob'), [
      'for: You like bob 2 out of 10.',
      'against: You like bob 2 out of 10.',
      'against: You called "bob took 2 coins from alice" selfish.',
    ]);
  });

  it('flips direction for a numeric the utility subtracts', () => {
    const { reasons } = build();
    assert.deepEqual(reasons('alice forgives bob'), [
      'against: You like bob 2 out of 10.',
      'against: You called "bob took 2 coins from alice" selfish.',
    ]);
  });

  it('leaves out facts with no template, and candidates with nothing behind them have no reasons', () => {
    const { reasons } = build();
    // quiet(alice) raised charitable for every candidate, but quiet has no template.
    assert.ok(reasons('alice blames carol').every(r => !r.includes('quiet')));
    // charitable(alice) is about alice alone, so what lowered it counts against blaming carol too.
    assert.deepEqual(reasons('alice blames carol'), [
      'against: You like bob 2 out of 10.',
      'against: You called "bob took 2 coins from alice" selfish.',
    ]);
  });

  it('uses the template named, and none of the ranking numbers', () => {
    const { engine } = build();
    const candidate = engine.scoreActionset('acts', { SELF: 'alice' }).find(c => c.label === 'alice blames bob');
    assert.deepEqual(engine.reasonsFor(candidate, { template: 'log' }), []);
    const reason = engine.reasonsFor(candidate)[0];
    assert.deepEqual(Object.keys(reason).sort(), ['direction', 'fact', 'rule', 'text']);
    assert.equal(reason.rule, 'dislike makes hostile');
  });
});

describe('{text[N]} in a text template', () => {
  it("renders an occurrence argument as its action's text", () => {
    const { engine, occurrence } = build();
    assert.equal(engine.renderFact({ name: 'called', args: [occurrence, 'selfish'] }, 'briefing'),
      'You called "bob took 2 coins from alice" selfish.');
    assert.equal(engine.occurrenceText(occurrence), 'bob took 2 coins from alice');
  });

  it('falls back to the entity name for an argument that is no occurrence', () => {
    const { engine } = build();
    assert.equal(engine.renderFact({ name: 'called', args: ['nothing-here', 'fair'] }, 'briefing'),
      'You called "nothing-here" fair.');
  });
});
