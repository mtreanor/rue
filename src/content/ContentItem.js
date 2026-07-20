export class ContentItem {
  get type() { throw new Error(`${this.constructor.name} must implement type`); }
  render(_binding) { throw new Error(`${this.constructor.name} must implement render(binding)`); }

  // Like render(), but as a sequence of { text, templated } segments instead
  // of a flat string — templated marks which spans came from a bound
  // variable rather than the authored template text, for UIs that want to
  // display the two differently (e.g. highlighting what was substituted).
  renderSegments(_binding) { throw new Error(`${this.constructor.name} must implement renderSegments(binding)`); }
}
