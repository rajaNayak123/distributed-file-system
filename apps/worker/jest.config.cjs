// jest.config.cjs — .cjs because package.json "type":"module"
module.exports = {
  verbose: true,
  clearMocks: true,
  testTimeout: 30000, // integration tests talk to real LocalStack/DynamoDB Local
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
      // Integration tests talk to real LocalStack/DynamoDB Local.
      // No moduleNameMapper overrides — real clients are used.
    },
  ],
};
