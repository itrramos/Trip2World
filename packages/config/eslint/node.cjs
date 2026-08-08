const base = require('./base.cjs');

/** ESLint config for Node.js services (api, realtime, worker). */
module.exports = {
  ...base,
  env: { ...base.env, node: true },
  rules: {
    ...base.rules,
    // Services use a structured logger; direct console access is a bug in production paths.
    'no-console': 'error',
  },
};
