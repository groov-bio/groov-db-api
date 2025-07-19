import { jest } from '@jest/globals';

const mockVerify = jest.fn();
const mockVerifier = {
  verify: mockVerify
};

jest.unstable_mockModule('aws-jwt-verify', () => ({
  CognitoJwtVerifier: {
    create: jest.fn(() => mockVerifier)
  }
}));

const { handler } = await import('../../functions/adminAuthorizer/adminAuthorizer.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('AdminAuthorizer Function', () => {
  beforeEach(() => {
    mockVerify.mockReset();
    
    process.env.USER_POOL_ID = 'test-user-pool-id';
    process.env.USER_POOL_CLIENT_ID = 'test-client-id';
    process.env.ADMIN_GROUP = 'admin';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Successful authorization', () => {
    test('should return isAuthorized true for valid token', async () => {
      mockVerify.mockResolvedValue(true);

      const event = {
        headers: {
          authorization: 'valid-jwt-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: true
      });
      expect(mockVerify).toHaveBeenCalledWith('valid-jwt-token');
      expect(console.log).toHaveBeenCalledWith('Admin verified');
    });

    test('should handle bearer token format', async () => {
      mockVerify.mockResolvedValue(true);

      const event = {
        headers: {
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: true
      });
      expect(mockVerify).toHaveBeenCalledWith('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
    });

    test('should only read lowercase authorization header', async () => {
      mockVerify.mockRejectedValue(new Error('Token is undefined'));

      const event = {
        headers: {
          Authorization: 'valid-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith(undefined);
    });
  });

  describe('Authorization failures', () => {
    test('should return isAuthorized false for invalid token', async () => {
      const verificationError = new Error('Token verification failed');
      mockVerify.mockRejectedValue(verificationError);

      const event = {
        headers: {
          authorization: 'invalid-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith('invalid-token');
      expect(console.log).toHaveBeenCalledWith('err: Error: Token verification failed');
    });

    test('should return isAuthorized false for expired token', async () => {
      const expiredError = new Error('Token expired');
      expiredError.name = 'TokenExpiredError';
      mockVerify.mockRejectedValue(expiredError);

      const event = {
        headers: {
          authorization: 'expired-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(console.log).toHaveBeenCalledWith('err: TokenExpiredError: Token expired');
    });

    test('should return isAuthorized false for user not in admin group', async () => {
      const groupError = new Error('User not in required group');
      groupError.name = 'ForbiddenError';
      mockVerify.mockRejectedValue(groupError);

      const event = {
        headers: {
          authorization: 'valid-token-wrong-group'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(console.log).toHaveBeenCalledWith('err: ForbiddenError: User not in required group');
    });

    test('should return isAuthorized false for malformed token', async () => {
      const malformedError = new Error('Invalid token format');
      malformedError.name = 'JsonWebTokenError';
      mockVerify.mockRejectedValue(malformedError);

      const event = {
        headers: {
          authorization: 'malformed.token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(console.log).toHaveBeenCalledWith('err: JsonWebTokenError: Invalid token format');
    });
  });

  describe('Missing or invalid headers', () => {
    test('should handle missing authorization header', async () => {
      const missingTokenError = new Error('Token is missing');
      mockVerify.mockRejectedValue(missingTokenError);

      const event = {
        headers: {}
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith(undefined);
    });

    test('should handle empty authorization header', async () => {
      const emptyTokenError = new Error('Token is empty');
      mockVerify.mockRejectedValue(emptyTokenError);

      const event = {
        headers: {
          authorization: ''
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith('');
      expect(console.log).toHaveBeenCalledWith('err: Error: Token is empty');
    });

    test('should handle null authorization header', async () => {
      const nullTokenError = new Error('Token is null');
      mockVerify.mockRejectedValue(nullTokenError);

      const event = {
        headers: {
          authorization: null
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith(null);
    });

    test('should throw error when headers object is missing', async () => {
      const event = {};

      await expect(handler(event)).rejects.toThrow("Cannot read properties of undefined (reading 'authorization')");
    });
  });

  describe('Edge cases', () => {
    test('should handle very long token', async () => {
      mockVerify.mockResolvedValue(true);
      const longToken = 'a'.repeat(10000);

      const event = {
        headers: {
          authorization: longToken
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: true
      });
      expect(mockVerify).toHaveBeenCalledWith(longToken);
    });

    test('should handle special characters in token', async () => {
      mockVerify.mockResolvedValue(true);
      const tokenWithSpecialChars = 'token-with-special_chars.and@symbols!';

      const event = {
        headers: {
          authorization: tokenWithSpecialChars
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: true
      });
      expect(mockVerify).toHaveBeenCalledWith(tokenWithSpecialChars);
    });

    test('should handle whitespace in token', async () => {
      const whitespaceError = new Error('Token contains invalid characters');
      mockVerify.mockRejectedValue(whitespaceError);

      const event = {
        headers: {
          authorization: '  token with spaces  '
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(mockVerify).toHaveBeenCalledWith('  token with spaces  ');
    });
  });

  describe('Verification method behavior', () => {
    test('should call verify method exactly once per request', async () => {
      mockVerify.mockResolvedValue(true);

      const event = {
        headers: {
          authorization: 'test-token'
        }
      };

      await handler(event);

      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockVerify).toHaveBeenCalledWith('test-token');
    });

    test('should handle async verification correctly', async () => {
      mockVerify.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve(true), 10))
      );

      const event = {
        headers: {
          authorization: 'async-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: true
      });
      expect(mockVerify).toHaveBeenCalledWith('async-token');
    });

    test('should handle verification timeout/rejection properly', async () => {
      const timeoutError = new Error('Verification timeout');
      timeoutError.name = 'TimeoutError';
      mockVerify.mockRejectedValue(timeoutError);

      const event = {
        headers: {
          authorization: 'timeout-token'
        }
      };

      const result = await handler(event);

      expect(result).toEqual({
        isAuthorized: false
      });
      expect(console.log).toHaveBeenCalledWith('err: TimeoutError: Verification timeout');
    });
  });

  describe('Return value structure', () => {
    test('should always return object with isAuthorized property', async () => {
      mockVerify.mockResolvedValue(true);

      const event = {
        headers: {
          authorization: 'test-token'
        }
      };

      const result = await handler(event);

      expect(result).toHaveProperty('isAuthorized');
      expect(typeof result.isAuthorized).toBe('boolean');
      expect(Object.keys(result)).toEqual(['isAuthorized']);
    });

    test('should return consistent structure on success and failure', async () => {
      mockVerify.mockResolvedValue(true);
      const successEvent = {
        headers: { authorization: 'valid-token' }
      };
      const successResult = await handler(successEvent);

      mockVerify.mockRejectedValue(new Error('Invalid'));
      const failureEvent = {
        headers: { authorization: 'invalid-token' }
      };
      const failureResult = await handler(failureEvent);

      expect(Object.keys(successResult)).toEqual(Object.keys(failureResult));
      expect(successResult).toHaveProperty('isAuthorized');
      expect(failureResult).toHaveProperty('isAuthorized');
    });
  });
});
