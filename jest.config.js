/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',          // no jsdom needed; all DOM is injected via mocks
  testMatch:       ['**/tests/**/*.test.js'],
  verbose:         true,
};
