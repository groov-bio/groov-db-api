export default {
  testEnvironment: 'node',
  transform: {},
  globals: {
    'ts-jest': {
      useESM: true
    }
  },
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'functions/**/*.js',
    '!functions/**/utils/lambdaInvoker.js',
    '!functions/**/utils/logger.js',
    '!functions/**/s3Updater.js',
    '!functions/**/*.test.js',
    '!functions/**/__tests__/**',
    '!**/node_modules/**'
  ],
  coverageReporters: [
    'text',
    'lcov',
    'html'
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 65,
      lines: 70,
      statements: 70
    }
  },
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.test.js'
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/.aws-sam/'
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
}; 