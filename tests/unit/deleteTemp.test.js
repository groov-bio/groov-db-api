import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/deleteTemp/deleteTemp.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  if (console.log.mockRestore) {
    console.log.mockRestore();
  }
  if (console.error.mockRestore) {
    console.error.mockRestore();
  }
  if (console.warn && console.warn.mockRestore) {
    console.warn.mockRestore();
  }
});

describe('DeleteTemp Function', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    
    process.env.TEMP_TABLE_NAME = 'test-temp-table';
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
      expect(result.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
      expect(result.body).toBeUndefined();
    });

    test('should use allowed origin for groov.bio', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use allowed origin for localhost', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'http://localhost:3000'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin for disallowed origins', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://malicious-site.com'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });

    test('should use default origin when no origin header is present', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {},
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('Successful deletion flow', () => {
    test('should successfully delete temp sensor data', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      const deleteCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'DeleteCommand');
      expect(deleteCall.args[0].input.TableName).toBe('test-temp-table');
      expect(deleteCall.args[0].input.Key.PK).toBe('TEMP');
      expect(deleteCall.args[0].input.Key.SK).toBe('P12345');
    });

    test('should handle different sensor IDs correctly', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'Q98765'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      const deleteCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'DeleteCommand');
      expect(deleteCall.args[0].input.Key.SK).toBe('Q98765');
    });

    test('should return correct CORS headers on success', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(result.headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(result.headers['Access-Control-Allow-Headers']).toBe('Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token');
      expect(result.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
      expect(result.headers['Access-Control-Max-Age']).toBe('86400');
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB delete errors', async () => {
      const deleteError = new Error('DynamoDB delete failed');
      docClientMock.on(DeleteCommand).rejects(deleteError);

      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
      expect(console.log).toHaveBeenCalledWith('No regular submission found for deletion, trying edit submission:', expect.any(String));
      expect(console.log).toHaveBeenCalledWith('No edit submission found for deletion:', expect.any(String));
      
      console.log.mockRestore();
    });

    test('should handle network timeout errors', async () => {
      docClientMock.on(DeleteCommand).rejects(new Error('Network timeout'));

      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      expect(console.log).toHaveBeenCalledWith('No regular submission found for deletion, trying edit submission:', expect.any(String));
      expect(console.log).toHaveBeenCalledWith('No edit submission found for deletion:', expect.any(String));
      
      console.log.mockRestore();
    });

    test('should handle missing queryStringParameters', async () => {
      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(console.log).toHaveBeenCalledWith('Handler error:', expect.any(Error));
      
      console.log.mockRestore();
    });

    test('should handle missing sensorId parameter', async () => {
      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {}
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(console.log).toHaveBeenCalledWith('Handler error:', expect.any(Error));
      
      console.log.mockRestore();
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variables', async () => {
      process.env.TEMP_TABLE_NAME = 'custom-temp-table';
      
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      await handler(event);

      const deleteCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'DeleteCommand');
      expect(deleteCall.args[0].input.TableName).toBe('custom-temp-table');
    });

    test('should work with IS_LOCAL environment variable', async () => {
      process.env.IS_LOCAL = 'true';
      
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'P12345'
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(202);
      
      // Clean up
      delete process.env.IS_LOCAL;
    });
  });

  describe('Request validation', () => {
    test('should handle empty sensorId', async () => {
      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: ''
        }
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(console.log).toHaveBeenCalledWith('Handler error:', expect.any(Error));
      
      console.log.mockRestore();
    });

    test('should handle null queryStringParameters', async () => {
      jest.spyOn(console, 'log');

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: null
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(console.log).toHaveBeenCalledWith('Handler error:', expect.any(Error));
      
      console.log.mockRestore();
    });
  });

  describe('DynamoDB command structure', () => {
    test('should create correct delete command structure', async () => {
      docClientMock.on(DeleteCommand).resolves({});

      const event = {
        requestContext: {
          http: {
            method: 'POST'
          }
        },
        headers: {
          origin: 'https://groov.bio'
        },
        queryStringParameters: {
          sensorId: 'TEST123'
        }
      };

      await handler(event);

      const deleteCall = docClientMock.calls().find(call => call.args[0].constructor.name === 'DeleteCommand');
      const params = deleteCall.args[0].input;
      
      expect(params).toHaveProperty('TableName');
      expect(params).toHaveProperty('Key');
      expect(params.Key).toEqual({
        PK: 'TEMP',
        SK: 'TEST123'
      });
    });
  });
});
