// ═══════════════════════════════════════════════
//  cypress.config.js
//  Cypress Configuration for Backend API Tests
// ═══════════════════════════════════════════════

const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4000',
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10000,
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    retries: {
      runMode: 1,
      openMode: 0,
    },
    env: {
      TEST_EMAIL: 'admin@qemma.local',
      TEST_PASSWORD: 'Admin123',
    },
    setupNodeEvents(on, config) {
      return config;
    },
  },
});