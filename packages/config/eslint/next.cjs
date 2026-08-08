const base = require('./base.cjs');

/** ESLint config for Next.js applications (web, admin). */
module.exports = {
  ...base,
  extends: [...base.extends, 'next/core-web-vitals'],
  env: { ...base.env, browser: true, node: true },
  rules: {
    ...base.rules,
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
};
