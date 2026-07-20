import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TextContentItem } from '../../src/content/TextContentItem.js';
import { Binding } from '../../src/Binding.js';
import { LogicalVariable } from '../../src/LogicalVariable.js';

const SELF  = new LogicalVariable('SELF');
const Y     = new LogicalVariable('Y');
const alice = { name: 'alice' };
const bob   = { name: 'bob' };

function binding() {
  return new Binding().extend(SELF, alice).extend(Y, bob);
}

describe('TextContentItem', () => {
  it('has type "text"', () => {
    assert.equal(new TextContentItem('hello').type, 'text');
  });

  it('substitutes entity names into the template', () => {
    const item = new TextContentItem('?SELF greets ?Y');
    assert.equal(item.render(binding()), 'alice greets bob');
  });

  it('substitutes a repeated variable', () => {
    const item = new TextContentItem('?SELF says hello to ?Y and ?Y waves back');
    assert.equal(item.render(binding()), 'alice says hello to bob and bob waves back');
  });

  it('substitutes a plain string value', () => {
    const item = new TextContentItem('topic: ?TOPIC');
    const b = new Binding().extend(new LogicalVariable('TOPIC'), 'karate');
    assert.equal(item.render(b), 'topic: karate');
  });

  it('leaves unbound variables unchanged', () => {
    const item = new TextContentItem('hello ?STRANGER');
    assert.equal(item.render(new Binding()), 'hello ?STRANGER');
  });

  it('renders a template with no variables unchanged', () => {
    const item = new TextContentItem('no variables here');
    assert.equal(item.render(new Binding()), 'no variables here');
  });

  it('only matches uppercase variable names', () => {
    // Lowercase ?x should not be substituted — regex is [A-Z][A-Z0-9_]*
    const item = new TextContentItem('?x is not a variable');
    assert.equal(item.render(binding()), '?x is not a variable');
  });

  describe('renderSegments', () => {
    it('splits literal text and substituted variables into segments', () => {
      const item = new TextContentItem('?SELF greets ?Y warmly');
      assert.deepEqual(item.renderSegments(binding()), [
        { text: 'alice', templated: true },
        { text: ' greets ', templated: false },
        { text: 'bob', templated: true },
        { text: ' warmly', templated: false },
      ]);
    });

    it('marks an unbound variable as literal, not templated', () => {
      const item = new TextContentItem('hello ?STRANGER');
      assert.deepEqual(item.renderSegments(new Binding()), [
        { text: 'hello ', templated: false },
        { text: '?STRANGER', templated: false },
      ]);
    });

    it('a template with no variables is a single literal segment', () => {
      const item = new TextContentItem('no variables here');
      assert.deepEqual(item.renderSegments(new Binding()), [
        { text: 'no variables here', templated: false },
      ]);
    });

    it('joining segment text reproduces render()\'s output', () => {
      const item = new TextContentItem('?SELF says hello to ?Y and ?Y waves back');
      const joined = item.renderSegments(binding()).map(s => s.text).join('');
      assert.equal(joined, item.render(binding()));
    });
  });
});
