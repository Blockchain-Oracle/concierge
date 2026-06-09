// Conventional Commits enforcement for Concierge.
// type-enum + subject-case at ERROR (block bad commits); scope-enum at
// WARN (typos surface, sensible new scopes don't block PRs).

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'subject-case': [2, 'never', ['upper-case', 'sentence-case']],
    'scope-enum': [
      1,
      'always',
      [
        // packages/
        'sdk',
        'shared',
        'agent',
        'tools',
        'ui',
        'skill',
        'react',
        'react-ui',
        'react-assistant-ui',
        'react-copilotkit',
        'vercel-ai',
        'openai',
        'langchain',
        'agentkit',
        'mcp',
        // packages/providers/
        'providers',
        'aave',
        'dex',
        'ethena',
        'ondo',
        'meth-staking',
        'lifi',
        'erc8004',
        // apps/
        'web',
        'worker',
        // contracts/
        'contracts',
        // operational
        'docs',
        'ci',
        'deps',
      ],
    ],
  },
};
