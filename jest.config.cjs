const sharedConfig = {
  clearMocks: true,
  rootDir: __dirname,
  testPathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/node_modules/'],
};
module.exports = {
  projects: [
    {
      ...sharedConfig,
      displayName: 'native',
      preset: 'react-native',
      testEnvironment: 'node',
      setupFilesAfterEnv: ['<rootDir>/jest.setup.native.ts'],
      transform: {
        '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['module:@react-native/babel-preset'] }],
      },
      transformIgnorePatterns: [
        'node_modules/.pnpm/(?!(?:react-native|jest-react-native|@react-native\\+[^/]+|@react-native-community\\+[^/]+)@)',
        'node_modules/(?!\\.pnpm|(?:react-native|jest-react-native|@react-native|@react-native-community)/)',
      ],
      testMatch: ['<rootDir>/src/**/*.native.test.ts', '<rootDir>/src/**/*.native.test.tsx'],
    },
    {
      ...sharedConfig,
      displayName: 'web',
      testEnvironment: 'jsdom',
      transform: {
        '^.+\\.[jt]sx?$': ['babel-jest', { presets: ['module:@react-native/babel-preset'] }],
      },
      moduleFileExtensions: ['web.ts', 'web.tsx', 'ts', 'tsx', 'js', 'jsx', 'json', 'node'],
      testMatch: ['<rootDir>/src/**/*.web.test.ts', '<rootDir>/src/**/*.web.test.tsx'],
    },
  ],
};
