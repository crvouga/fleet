const { createSharedBlocks } = require('../eslint-rules/base-config.cjs');

module.exports = createSharedBlocks(__dirname, {
  filesGlob: '{bdd/**/*.ts,playwright.config.ts}',
});
