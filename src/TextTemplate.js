// Fills a predicate's text template (see PredicateSchema toString, docs/schema.md).
//
//   {args[N]}  the fact's Nth argument (0-based), as an entity name
//   {text[N]}  the text of the occurrence in the Nth argument: its action's
//              rendered content (an external action's text); for an argument
//              that isn't an occurrence with text, its entity name
//   {value}    the fact's value: the number for a numeric fact; true, or false
//              for an explicitly negated boolean
//   {tier}     the name of the tier a numeric value falls in (empty if none)
//
// Anything else in braces, including an out-of-range {args[N]} or {text[N]},
// is left in the text exactly as written.
const PLACEHOLDER = /\{(?:(args|text)\[(\d+)\]|(value)|(tier))\}/g;

export function renderTemplate(template, { args = [], value = '', tier = '', textOf = null } = {}) {
  return template.replace(PLACEHOLDER, (match, kind, index, isValue, isTier) => {
    if (index !== undefined) {
      const arg = args[Number(index)];
      if (arg === undefined) return match;
      const name = String(arg?.name ?? arg);
      return kind === 'text' ? (textOf?.(name) ?? name) : name;
    }
    if (isValue) return String(value);
    return tier ?? '';
  });
}
