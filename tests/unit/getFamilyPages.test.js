import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

const { handler } = await import('../../functions/getFamilyPages/getFamilyPages.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetFamilyPages Function', () => {
  beforeEach(() => {
    s3Mock.reset();
    process.env.R2_BUCKET_NAME = 'test-bucket';
    process.env.R2_ENDPOINT = 'https://test-endpoint.com';
    process.env.R2_ACCESS_KEY_ID = 'test-key';
    process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  });

  afterEach(() => {
    jest.clearAllMocks();
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

    test('should use default origin for disallowed origins', async () => {
      const mockFamilyData = {
        family: 'TestFamily',
        sensors: [
          { alias: 'TestSensor1', ligandCount: 5 },
          { alias: 'TestSensor2', ligandCount: 3 }
        ],
        count: 2
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockFamilyData)));
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Query parameter validation', () => {
    test('should return 400 when family parameter is missing', async () => {
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

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Missing query string parameter: family');
    });

    test('should return 400 when queryStringParameters is null', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: null
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Missing query string parameter: family');
    });

    test('should return 400 when family parameter is empty', async () => {
      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          family: ''
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Missing query string parameter: family');
    });
  });

  describe('S3 data fetching', () => {
    test('should successfully fetch and return family data', async () => {
      const mockFamilyData = {
        family: 'TestFamily',
        sensors: [
          { alias: 'TestSensor1', ligandCount: 5 },
          { alias: 'TestSensor2', ligandCount: 3 }
        ],
        count: 2
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockFamilyData)));
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual(mockFamilyData);
      
      const s3Calls = s3Mock.calls();
      expect(s3Calls.length).toBe(1);
      expect(s3Calls[0].args[0].input.Key).toBe('indexes/testfamily.json');
    });

    test('should convert family name to lowercase for S3 key', async () => {
      const mockFamilyData = {
        family: 'UPPERCASEFAMILY',
        sensors: [],
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockFamilyData)));
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
        },
        queryStringParameters: {
          family: 'UPPERCASEFAMILY'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const s3Calls = s3Mock.calls();
      expect(s3Calls[0].args[0].input.Key).toBe('indexes/uppercasefamily.json');
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch family data');
    });

    test('should handle S3 NoSuchKey error for non-existent family', async () => {
      const noSuchKeyError = new Error('NoSuchKey');
      noSuchKeyError.name = 'NoSuchKey';
      s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          family: 'NonExistentFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch family data');
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch family data');
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Error on getting family');
    });

    test('should handle stream errors', async () => {
      const stream = new Readable({
        read() {
          this.emit('error', new Error('Stream error'));
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
        },
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Failed to fetch family data');
    });
  });

  describe('Edge cases', () => {
    test('should handle family names with special characters', async () => {
      const mockFamilyData = {
        family: 'Test-Family_123',
        sensors: [],
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockFamilyData)));
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
        },
        queryStringParameters: {
          family: 'Test-Family_123'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      
      const s3Calls = s3Mock.calls();
      expect(s3Calls[0].args[0].input.Key).toBe('indexes/test-family_123.json');
    });

    test('should handle missing origin header', async () => {
      const mockFamilyData = {
        family: 'TestFamily',
        sensors: [],
        count: 0
      };

      const stream = new Readable({
        read() {
          this.push(Buffer.from(JSON.stringify(mockFamilyData)));
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
        queryStringParameters: {
          family: 'TestFamily'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });
});
