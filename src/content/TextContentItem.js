import { ContentItem } from './ContentItem.js';
import { toFactArg } from '../entityValue.js';

export class TextContentItem extends ContentItem {
  constructor(template) {
    super();
    this.template = template;
  }

  get type() { return 'text'; }

  // templated:true marks a span that came from a resolved binding; an unbound
  // variable renders as its literal `?NAME` placeholder and is NOT templated
  // — nothing was actually substituted there.
  renderSegments(binding) {
    const segments = [];
    const re = /\?([A-Z][A-Z0-9_]*)/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(this.template))) {
      if (match.index > lastIndex) {
        segments.push({ text: this.template.slice(lastIndex, match.index), templated: false });
      }
      const value = binding.assignments.get(match[1]);
      segments.push(value === undefined
        ? { text: match[0], templated: false }
        : { text: String(toFactArg(value)), templated: true });
      lastIndex = re.lastIndex;
    }
    if (lastIndex < this.template.length) {
      segments.push({ text: this.template.slice(lastIndex), templated: false });
    }
    return segments;
  }

  render(binding) {
    return this.renderSegments(binding).map(s => s.text).join('');
  }
}
