// Fills a predicate's text template (see PredicateSchema toString, docs/schema.md).
//
//   {args[N]}  the fact's Nth argument (0-based), as an entity name
//   {value}    the fact's value: the number for a numeric fact; true, or false
//              for an explicitly negated boolean
//   {tier}     the name of the tier a numeric value falls in (empty if none)
//
// Anything else in braces, including an out-of-range {args[N]}, is left in the
// text exactly as written.
const PLACEHOLDER = /\{(?:args\[(\d+)\]|(value)|(tier))\}/g;

export function renderTemplate(template, { args = [], value = '', tier = '' } = {}) {
  return template.replace(PLACEHOLDER, (match, index, isValue, isTier) => {
    if (index !== undefined) {
      const arg = args[Number(index)];
      return arg === undefined ? match : String(arg?.name ?? arg);
    }
    if (isValue) return String(value);
    return tier ?? '';
  });
}
