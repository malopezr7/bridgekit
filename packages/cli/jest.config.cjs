module.exports = {
  // Tests import @malopezr7/bridgekit/contract from core dist; run `pnpm --filter @malopezr7/bridgekit build` first in clean clones.
  // `test:hash` scopes current hash tests; `test:codec` intentionally uses --passWithNoTests until slice 6b codec snapshots land.
  clearMocks: true,
  rootDir: __dirname,
  testEnvironment: 'node',
  testPathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/node_modules/'],
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['module:@react-native/babel-preset'] }],
  },
  moduleNameMapper: {
    '^@malopezr7/bridgekit/contract$': '<rootDir>/../core/src/contract/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['<rootDir>/src/**/*.test.ts'],
};
