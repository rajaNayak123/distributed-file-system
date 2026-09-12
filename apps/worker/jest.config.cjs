module.exports = {
  verbose: true,
  clearMocks: true,
  testTimeout: 30000,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      setupFiles: ['<rootDir>/tests/setupEnv.js'],
      transform: { '^.+\\.js$': 'babel-jest' },
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      setupFiles: ['<rootDir>/tests/setupEnv.js'],
      transform: { '^.+\\.js$': 'babel-jest' },
    },
  ],
};
