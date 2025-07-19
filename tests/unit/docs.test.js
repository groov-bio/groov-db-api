import { jest } from '@jest/globals';

const mockReadFileSync = jest.fn();
jest.unstable_mockModule('fs', () => ({
  readFileSync: mockReadFileSync
}));

const mockJoin = jest.fn();
const mockDirname = jest.fn();
jest.unstable_mockModule('path', () => ({
  join: mockJoin,
  dirname: mockDirname
}));

const mockYamlLoad = jest.fn();
jest.unstable_mockModule('js-yaml', () => ({
  load: mockYamlLoad
}));

const { handler } = await import('../../functions/docs/docs.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('Docs Function', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockJoin.mockReset();
    mockDirname.mockReset();
    mockYamlLoad.mockReset();
    
    mockJoin.mockImplementation((...args) => args.join('/'));
    mockDirname.mockImplementation((path) => path.split('/').slice(0, -1).join('/'));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('CORS handling', () => {
    test('should handle OPTIONS request with proper CORS headers', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'OPTIONS'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', 'https://groov.bio');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Credentials', 'true');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Methods', 'POST,OPTIONS');
    });

    test('should use allowed origin or default to localhost', async () => {
      const mockSwaggerContent = 'openapi: 3.0.0\ninfo:\n  title: Test API';
      const mockSwaggerJson = { openapi: '3.0.0', info: { title: 'Test API' } };
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const allowedEvent = {
        headers: { origin: 'https://groov.bio' }
      };
      const allowedResult = await handler(allowedEvent);
      expect(allowedResult.headers).toHaveProperty('Access-Control-Allow-Origin', 'https://groov.bio');

      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const unknownEvent = {
        headers: { origin: 'https://unknown-domain.com' }
      };
      const unknownResult = await handler(unknownEvent);
      expect(unknownResult.headers).toHaveProperty('Access-Control-Allow-Origin', 'http://localhost:3000');
    });
  });

  describe('Successful documentation generation', () => {
    test('should successfully generate HTML documentation', async () => {
      const mockSwaggerContent = 'openapi: 3.0.0\ninfo:\n  title: Test API\n  version: 1.0.0';
      const mockSwaggerJson = { 
        openapi: '3.0.0', 
        info: { title: 'Test API', version: '1.0.0' } 
      };
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const event = { headers: {} };
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/html');
      expect(result.body).toContain('Groov API Documentation');
      expect(result.body).toContain('swagger-ui');
      expect(result.body).toContain('"title":"Test API"');
    });

    test('should add default openapi version when missing', async () => {
      const mockSwaggerContent = 'info:\n  title: Test API';
      const mockSwaggerJson = { info: { title: 'Test API' } };
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const event = { headers: {} };
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"openapi":"3.0.0"');
    });

  });

  describe('Error handling', () => {
    test('should return 500 when swagger file is not found', async () => {
      mockReadFileSync.mockImplementation(() => { 
        throw new Error('File not found'); 
      });

      const event = { headers: {} };
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(result.body)).toEqual({
        message: 'Failed to generate API documentation',
        error: 'Swagger YAML file not found'
      });
    });

    test('should return 500 when YAML parsing fails', async () => {
      const mockSwaggerContent = 'invalid yaml content';
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockImplementation(() => {
        throw new Error('Invalid YAML format');
      });

      const event = { headers: {} };
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(result.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Failed to generate API documentation');
      expect(body.error).toBeTruthy();
    });

    test('should include CORS headers in error responses', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File error');
      });

      const event = {
        headers: { origin: 'https://groov.bio' }
      };
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', 'https://groov.bio');
      expect(result.headers).toHaveProperty('Access-Control-Allow-Credentials', 'true');
    });
  });

  describe('Edge cases', () => {
    test('should handle missing headers object', async () => {
      const mockSwaggerContent = 'openapi: 3.0.0\ninfo:\n  title: Test API';
      const mockSwaggerJson = { openapi: '3.0.0', info: { title: 'Test API' } };
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const event = {};
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Access-Control-Allow-Origin', 'http://localhost:3000');
    });

    test('should handle empty swagger definition', async () => {
      const mockSwaggerContent = '{}';
      const mockSwaggerJson = {};
      
      mockReadFileSync.mockReturnValue(mockSwaggerContent);
      mockYamlLoad.mockReturnValue(mockSwaggerJson);

      const event = { headers: {} };
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('"openapi":"3.0.0"');
    });
  });
});
