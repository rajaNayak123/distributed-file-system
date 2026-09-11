module.exports = {
  verbose: true,
  clearMocks: true,
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
      moduleNameMapper: {
        '^../repositories/files\\.repository\\.js$': '<rootDir>/tests/fakes/fakeFilesRepository.js',
        '^../repositories/users\\.repository\\.js$': '<rootDir>/tests/fakes/fakeUsersRepository.js',
        '^../repositories/idempotency\\.repository\\.js$': '<rootDir>/tests/fakes/fakeIdempotencyRepository.js',
        '^./storage\\.service\\.js$': '<rootDir>/tests/fakes/fakeStorageService.js',

      },
    },
    {
      displayName: 'failure',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/failure/**/*.test.js'],
      setupFiles: ['<rootDir>/tests/setupEnv.js'],
      transform: { '^.+\\.js$': 'babel-jest' },
      moduleNameMapper: {
        '^../repositories/files\\.repository\\.js$': '<rootDir>/tests/fakes/fakeFilesRepository.js',
        '^../repositories/users\\.repository\\.js$': '<rootDir>/tests/fakes/fakeUsersRepository.js',
        '^../repositories/idempotency\\.repository\\.js$': '<rootDir>/tests/fakes/fakeIdempotencyRepository.js',
        '^./storage\\.service\\.js$': '<rootDir>/tests/fakes/fakeStorageService.js',
        '^../../src/repositories/files\\.repository\\.js$': '<rootDir>/tests/fakes/fakeFilesRepository.js',
        '^../../src/repositories/users\\.repository\\.js$': '<rootDir>/tests/fakes/fakeUsersRepository.js',
        '^../../src/repositories/idempotency\\.repository\\.js$': '<rootDir>/tests/fakes/fakeIdempotencyRepository.js',
        '^../fakes/fakeStorageService\\.js$': '<rootDir>/tests/fakes/fakeStorageService.js',
      },
    },
  ],
};

