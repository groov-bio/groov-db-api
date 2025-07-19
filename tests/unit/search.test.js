import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

const { handler } = await import('../../functions/search/search.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('Search Function', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.R2_BUCKET_NAME = 'test-bucket';
    process.env.R2_ENDPOINT = 'https://test-endpoint.com';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Environment configuration', () => {
    test('should use local S3 configuration when IS_LOCAL is set', async () => {
      process.env.IS_LOCAL = 'true';
      process.env.S3_BUCKET_NAME = 'local-test-bucket';

      const mockData = {
        sensors: [{ alias: 'TestSensor', family: 'TestFamily', ligandCount: 5 }],
        count: 1
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });

    test('should use default bucket name when S3_BUCKET_NAME is not set in local mode', async () => {
      process.env.IS_LOCAL = 'true';
      delete process.env.S3_BUCKET_NAME;

      const mockData = { sensors: [], count: 0 };
      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
    });
  });

  describe('CORS handling', () => {
    test('should handle OPTIONS request', async () => {
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
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
    });

    test('should handle Origin header (capital O)', async () => {
      const mockData = { sensors: [], count: 0 };
      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { Origin: 'https://www.groov.bio' }
      };

      const result = await handler(event);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin when no origin header is provided', async () => {
      const mockData = { sensors: [], count: 0 };
      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: {}
      };

      const result = await handler(event);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin for disallowed origins', async () => {
      const mockData = {
        sensors: [
          { alias: 'TestSensor', family: 'TestFamily', ligandCount: 5 }
        ],
        count: 1
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('S3 data fetching', () => {
    test('should successfully fetch and return index data', async () => {
      const mockData = {
        sensors: [
          { alias: 'TestSensor1', family: 'TestFamily1', ligandCount: 5 },
          { alias: 'TestSensor2', family: 'TestFamily2', ligandCount: 3 }
        ],
        count: 2
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(mockData);
      expect(s3Mock.calls().length).toBeGreaterThan(0);
    });

    test('should handle S3 errors gracefully', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('S3 connection failed'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch index from S3');
    });

    test('should handle generic errors without statusCode', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('Generic error without statusCode'));

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error on search');
    });
  });

  describe('Error handling', () => {
    test('should handle malformed JSON from S3', async () => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from('invalid json'));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch index from S3');
    });

    test('should handle unexpected errors', async () => {
      s3Mock.on(GetObjectCommand).rejects(new Error('Unexpected error'));

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error on search');
    });
  });

  describe('Calculate stats function coverage', () => {
    test('should handle calculateStats with valid data when stats=true', async () => {
      const mockData = {
        sensors: [
          { 
            alias: 'TestSensor1', 
            family: 'TestFamily1', 
            ligandCount: 5 
          },
          { 
            alias: 'TestSensor2', 
            family: 'TestFamily2', 
            ligandCount: 3 
          },
          { 
            family: 'TestFamily3', 
            ligandCount: 2 
          }
        ],
        count: 3
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      
      const responseData = JSON.parse(result.body);
      expect(responseData).toHaveProperty('stats');
      expect(responseData.stats.ligands).toBe(10);
      expect(responseData.stats.regulators).toBe(2);
      expect(responseData.stats.sensorCount).toBe(3);
    });

    test('should handle calculateStats with sensors without ligandCount', async () => {
      const mockData = {
        sensors: [
          { alias: 'TestSensor1', family: 'TestFamily1' },
          { alias: 'TestSensor2', family: 'TestFamily2', ligandCount: 0 }
        ],
        count: 2
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      
      const responseData = JSON.parse(result.body);
      expect(responseData.stats.ligands).toBe(0);
      expect(responseData.stats.regulators).toBe(2);
    });

    test('should handle calculateStats with null indexData', async () => {
      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(null)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(422);
      
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Data processing failed for search');
    });

    test('should handle calculateStats with missing sensors array', async () => {
      const mockData = {
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(422);
      
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Data processing failed for search');
    });

    test('should handle calculateStats with non-array sensors', async () => {
      const mockData = {
        sensors: "not an array",
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(422);
      
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Data processing failed for search');
    });

    test('should handle calculateStats with empty sensors array', async () => {
      const mockData = {
        sensors: [],
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      
      const responseData = JSON.parse(result.body);
      expect(responseData.stats.ligands).toBe(0);
      expect(responseData.stats.regulators).toBe(0);
      expect(responseData.stats.sensorCount).toBe(0);
    });

    test('should handle calculateStats using indexData.count when available', async () => {
      const mockData = {
        sensors: [
          { alias: 'TestSensor1', family: 'TestFamily1', ligandCount: 5 }
        ],
        count: 10
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      
      const responseData = JSON.parse(result.body);
      expect(responseData.stats.sensorCount).toBe(10);
    });

    test('should handle calculateStats using sensors.length when count is missing', async () => {
      const mockData = {
        sensors: [
          { alias: 'TestSensor1', family: 'TestFamily1', ligandCount: 5 },
          { alias: 'TestSensor2', family: 'TestFamily2', ligandCount: 3 }
        ]
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockData)));
          this.push(null);
        }
      });
      
      s3Mock.on(GetObjectCommand).resolves({ Body: stream });

      const event = {
        requestContext: { http: { method: 'GET' } },
        headers: { origin: 'https://groov.bio' },
        queryStringParameters: { stats: 'true' }
      };

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      
      const responseData = JSON.parse(result.body);
      expect(responseData.stats.sensorCount).toBe(2);
    });
  });
}); 