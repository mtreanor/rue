import { defineConfig } from 'vitepress';
import mathjax3 from 'markdown-it-mathjax3';
import klughGrammar from './klugh-grammar.js';

export default defineConfig({
  title: 'klugh',
  description: 'A symbolic logic engine for reasoning about state',
  base: '/klugh/',

  // Scratch/archive notes that are not part of the published site. Keeping
  // them out of the build means a stray dead link in a draft can't fail the
  // deploy (VitePress aborts the whole build on any dead link).
  srcExclude: ['old/**', 'ml-ideas.md'],

  markdown: {
    languages: [klughGrammar],
    config: (md) => {
      md.use(mathjax3);
    },
  },

  themeConfig: {
    nav: [
      { text: 'Quickstart', link: '/quickstart/' },
      { text: 'Reference', link: '/' },
    ],

    sidebar: [
      {
        items: [
          { text: 'What is klugh?', link: '/' },
          { text: 'History', link: '/history' },
        ],
      },
      {
        text: 'Quickstart',
        items: [
          { text: 'Overview', link: '/quickstart/' },
          { text: '1 · Worlds & queries', link: '/quickstart/worlds-and-queries' },
          { text: '1.5 · Provenance', link: '/quickstart/provenance' },
          { text: '2 · Actions', link: '/quickstart/actions' },
          { text: '2.5 · Action records', link: '/quickstart/action-records' },
        ],
      },
      {
        text: 'Language Reference',
        items: [
          { text: 'Overview', link: '/overview' },
          { text: 'Schema', link: '/schema' },
          { text: 'State files', link: '/state' },
          { text: 'Negation', link: '/negation' },
          { text: 'Query forms', link: '/query-forms' },
          { text: 'Private stores', link: '/private-stores' },
          { text: 'Rules', link: '/rules' },
          { text: 'Derived predicates', link: '/derived-predicates' },
          { text: 'Sensor predicates', link: '/sensors' },
          { text: 'Actuator predicates', link: '/actuators' },
          { text: 'LLM configuration', link: '/llm' },
          { text: 'Actions', link: '/actions' },
          { text: 'Action records', link: '/action-records' },
          { text: 'Pipelines', link: '/pipeline' },
          { text: 'Provenance', link: '/provenance' },
          { text: 'REPL', link: '/repl' },
        ],
      },
      {
        text: 'Tools',
        items: [
          { text: 'action-rule-set-tool', link: '/action-rule-set-tool' },
        ],
      },
    ],

    socialLinks: [],
  },
});
