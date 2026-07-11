import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/getTempSensor/getTempSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetTempSensor Function', () => {
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
      expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
      expect(result.body).toBeUndefined();
    });

    test('should use allowed origin for groov.bio', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' },
          { PK: 'TEMP', alias: 'TempSensor2', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should use allowed origin for www.groov.bio', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          origin: 'https://www.groov.bio'
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
    });

    test('should use default origin for disallowed origins', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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

    test('should use default origin when no origin header is present', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });

  describe('DynamoDB data fetching', () => {
    test('should successfully fetch and return temp sensor data', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP', ligandCount: 5 },
          { PK: 'TEMP', alias: 'TempSensor2', family: 'TEMP', ligandCount: 3 }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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
      const responseBody = JSON.parse(result.body);
      expect(responseBody).toEqual(mockData.Items);
      
      const dynamoDbCalls = docClientMock.calls();
      expect(dynamoDbCalls.length).toBe(1);
      expect(dynamoDbCalls[0].args[0].input.TableName).toBe('test-temp-table');
      expect(dynamoDbCalls[0].args[0].input.KeyConditionExpression).toBe('PK = :PK');
      expect(dynamoDbCalls[0].args[0].input.ExpressionAttributeValues[':PK']).toBe('TEMP');
    });

    test('should return empty array when no items found', async () => {
      const mockData = {
        Items: []
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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
      const responseBody = JSON.parse(result.body);
      expect(responseBody).toEqual([]);
    });

    test('should handle single item response', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'SingleTempSensor', family: 'TEMP', ligandCount: 10 }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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
      const responseBody = JSON.parse(result.body);
      expect(responseBody).toHaveLength(1);
      expect(responseBody[0]).toEqual(mockData.Items[0]);
    });
  });

  describe('Data formatting', () => {
    test('should preserve all item properties during formatting', async () => {
      const mockData = {
        Items: [
          { 
            PK: 'TEMP', 
            alias: 'ComplexTempSensor', 
            family: 'TEMP', 
            ligandCount: 15,
            description: 'A complex temperature sensor',
            metadata: { created: '2023-01-01', version: '1.0' }
          }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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
      const responseBody = JSON.parse(result.body);
      expect(responseBody[0]).toEqual(mockData.Items[0]);
      expect(responseBody[0].metadata).toEqual({ created: '2023-01-01', version: '1.0' });
    });

    test('should handle items with missing properties', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP' },
          { PK: 'TEMP', alias: 'PartialSensor' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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
      const responseBody = JSON.parse(result.body);
      expect(responseBody).toHaveLength(2);
      expect(responseBody[0]).toEqual({ PK: 'TEMP' });
      expect(responseBody[1]).toEqual({ PK: 'TEMP', alias: 'PartialSensor' });
    });
  });

  describe('Error handling', () => {
    test('should handle DynamoDB errors gracefully', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('DynamoDB connection failed'));

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
      expect(body.message).toBe('Error on getting temp sensors, please check logs');
    });

    test('should handle AccessDeniedException', async () => {
      const accessDeniedError = new Error('AccessDeniedException');
      accessDeniedError.name = 'AccessDeniedException';
      docClientMock.on(QueryCommand).rejects(accessDeniedError);

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
      expect(body.message).toBe('Error on getting temp sensors, please check logs');
    });

    test('should handle ResourceNotFoundException', async () => {
      const resourceNotFoundError = new Error('ResourceNotFoundException');
      resourceNotFoundError.name = 'ResourceNotFoundException';
      docClientMock.on(QueryCommand).rejects(resourceNotFoundError);

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
      expect(body.message).toBe('Error on getting temp sensors, please check logs');
    });

    test('should handle unexpected errors', async () => {
      docClientMock.on(QueryCommand).rejects(new Error('Unexpected error'));

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
      expect(body.message).toBe('Error on getting temp sensors, please check logs');
    });
  });

  describe('Environment configuration', () => {
    test('should use correct table name from environment variable', async () => {
      process.env.TEMP_TABLE_NAME = 'production-temp-table';
      
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

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

      await handler(event);

      const dynamoDbCalls = docClientMock.calls();
      expect(dynamoDbCalls[0].args[0].input.TableName).toBe('production-temp-table');
    });
  });

  describe('Edge cases', () => {
    test('should handle case-sensitive Origin header', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

      const event = {
        requestContext: {
          http: {
            method: 'GET'
          }
        },
        headers: {
          Origin: 'https://groov.bio' // Capital O
        }
      };

      const result = await handler(event);

      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
    });

    test('should handle undefined Items in DynamoDB response', async () => {
      const mockData = {};

      docClientMock.on(QueryCommand).resolves(mockData);

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
      expect(body.message).toBe('Error on getting temp sensors, please check logs');
    });

    test('should handle malformed event object', async () => {
      const mockData = {
        Items: [
          { PK: 'TEMP', alias: 'TempSensor1', family: 'TEMP' }
        ]
      };

      docClientMock.on(QueryCommand).resolves(mockData);

      const event = {};

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    });
  });
});
