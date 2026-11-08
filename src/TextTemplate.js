// Fills a predicate's text template (see PredicateSchema toString, docs/schema.md).
//
//   {args[N]}  the fact's Nth argument (0-based), as an entity name
//   {text[N]}  the text of the occurrence in the Nth argument: its action's
//              rendered content (an external action's text); for an argument
//              that isn't an occurrence with text, its entity name
//   {value}    the fact's value: the number for a numeric fact; true, or false
//              for an explicitly negated boolean
//   {tier}     the name of the tier a numeric value falls in (empty if none)
//   {abs}      the absolute value of a numeric fact's value
//
// A template is a string, or sign forms chosen by a numeric fact's value:
// { "positive": "...", "negative": "...", "zero": "..." } (a missing "zero"
// falls back to "positive"; a non-numeric fact uses "positive"). Sign forms let
// the wording carry the direction, so a number never needs a sign:
// "cost carol {abs} hours" against "saved bob {abs} hours".
//
// Anything else in braces, including an out-of-range {args[N]} or {text[N]},
// is left in the text exactly as written.
const PLACEHOLDER = /\{(?:(args|text)\[(\d+)\]|(value)|(tier)|(abs))\}/g;
export const SIGN_FORMS = ['positive', 'negative', 'zero'];

// The form of a template that applies to a value: the template itself, or one of its sign forms.
export function templateForm(template, value) {
  if (typeof template === 'string') return template;
  const n = typeof value === 'number' ? value : NaN;
  if (n < 0) return template.negative;
  if (n === 0 && template.zero !== undefined) return template.zero;
  return template.positive;
}

export function renderTemplate(template, { args = [], value = '', tier = '', textOf = null } = {}) {
  const form = templateForm(template, value);
  if (typeof form !== 'string') return null;
  return form.replace(PLACEHOLDER, (match, kind, index, isValue, isTier, isAbs) => {
    if (index !== undefined) {
      const arg = args[Number(index)];
      if (arg === undefined) return match;
      const name = String(arg?.name ?? arg);
      return kind === 'text' ? (textOf?.(name) ?? name) : name;
    }
    if (isValue) return String(value);
    if (isAbs) return typeof value === 'number' ? String(Math.abs(value)) : String(value);
    return tier ?? '';
  });
}
